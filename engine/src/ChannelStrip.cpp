#include "ChannelStrip.h"

ChannelStrip::ChannelStrip() = default;
ChannelStrip::~ChannelStrip() = default;

void ChannelStrip::prepare(double sampleRate, int blockSize)
{
    sr = sampleRate;
    bs = blockSize;
    pluginBuffer.setSize(2, blockSize, false, true, true);
    for (auto& p : ownedSlots)
        if (p) {
            p->setPlayConfigDetails(juce::jmax(1, p->getTotalNumInputChannels()), 2, sampleRate, blockSize);
            p->prepareToPlay(sampleRate, blockSize);
        }
}

void ChannelStrip::release()
{
    for (auto& p : ownedSlots)
        if (p) p->releaseResources();
}

void ChannelStrip::setPluginAt(int slot, std::unique_ptr<juce::AudioPluginInstance> plugin, double sampleRate, int blockSize,
                               const juce::MemoryBlock& state)
{
    if (slot < 0 || slot >= MAX_PLUGINS) return;

    if (plugin)
    {
        // Order matters: setPlayConfigDetails -> prepareToPlay -> setStateInformation.
        // Many plugins allocate internal buffers in prepareToPlay that state restore
        // depends on; calling setStateInformation on an unprepared plugin segfaults.
        plugin->setPlayConfigDetails(juce::jmax(1, plugin->getTotalNumInputChannels()), 2, sampleRate, blockSize);
        plugin->prepareToPlay(sampleRate, blockSize);
        if (state.getSize() > 0)
        {
            try { plugin->setStateInformation(state.getData(), (int) state.getSize()); }
            catch (...) { /* ignore malformed state — plugin keeps default settings */ }
        }
    }
    auto* raw = plugin.release();

    // Drop previously-retired plugin for this slot now (off the audio thread).
    if (retiredSlots[(size_t) slot])
        retiredSlots[(size_t) slot].reset();

    // Move current owner to retired.
    retiredSlots[(size_t) slot] = std::move(ownedSlots[(size_t) slot]);
    ownedSlots[(size_t) slot].reset(raw);

    pendingSlots[(size_t) slot].store(raw);
    pendingVersions[(size_t) slot].fetch_add(1, std::memory_order_release);
}

void ChannelStrip::clearSlot(int slot)
{
    setPluginAt(slot, nullptr, sr, bs);
}

void ChannelStrip::moveSlot(int fromSlot, int toSlot)
{
    if (fromSlot == toSlot) return;
    if (fromSlot < 0 || fromSlot >= MAX_PLUGINS) return;
    if (toSlot   < 0 || toSlot   >= MAX_PLUGINS) return;

    // Reorder is purely a shuffle of pointer ownership between slots — no
    // plugin instance is destroyed or recreated, so we don't engage the
    // retiredSlots cleanup path used by setPluginAt.
    auto moved          = std::move(ownedSlots[(size_t) fromSlot]);
    const bool movedByp = bypassedSlots[(size_t) fromSlot].load();

    if (fromSlot < toSlot)
    {
        for (int i = fromSlot; i < toSlot; ++i)
        {
            ownedSlots[(size_t) i] = std::move(ownedSlots[(size_t) (i + 1)]);
            bypassedSlots[(size_t) i].store(bypassedSlots[(size_t) (i + 1)].load());
        }
    }
    else
    {
        for (int i = fromSlot; i > toSlot; --i)
        {
            ownedSlots[(size_t) i] = std::move(ownedSlots[(size_t) (i - 1)]);
            bypassedSlots[(size_t) i].store(bypassedSlots[(size_t) (i - 1)].load());
        }
    }

    ownedSlots[(size_t) toSlot] = std::move(moved);
    bypassedSlots[(size_t) toSlot].store(movedByp);

    // Republish all touched slots' pending pointers and bump versions; the
    // audio thread will hot-swap activeSlots[i] = pendingSlots[i] on its next
    // process() call, picking up the new chain order in one buffer.
    const int lo = juce::jmin(fromSlot, toSlot);
    const int hi = juce::jmax(fromSlot, toSlot);
    for (int i = lo; i <= hi; ++i)
    {
        pendingSlots[(size_t) i].store(ownedSlots[(size_t) i].get());
        pendingVersions[(size_t) i].fetch_add(1, std::memory_order_release);
    }
}

juce::AudioPluginInstance* ChannelStrip::getPluginAt(int slot) const noexcept
{
    if (slot < 0 || slot >= MAX_PLUGINS) return nullptr;
    // Read from ownedSlots, not activeSlots: ownedSlots is updated synchronously
    // by setPluginAt on the message thread, while activeSlots is only swapped in
    // by the audio thread's process() call. Callers (editor open, getStateInformation)
    // run on the message thread and need the authoritative current plugin even
    // before the next audio callback fires.
    return ownedSlots[(size_t) slot].get();
}

int ChannelStrip::getNumActivePlugins() const noexcept
{
    int n = 0;
    for (auto& a : activeSlots) if (a.load()) ++n;
    return n;
}

int ChannelStrip::getChainLatencySamples() const noexcept
{
    int total = 0;
    for (int i = 0; i < MAX_PLUGINS; ++i)
    {
        if (bypassedSlots[(size_t) i].load()) continue;
        if (auto* p = ownedSlots[(size_t) i].get())
            total += juce::jmax(0, p->getLatencySamples());
    }
    return total;
}

void ChannelStrip::process(const float* inSamples, float* outL, float* outR, int numSamples)
{
    // Hot-swap pending → active for any slot whose version changed.
    for (int i = 0; i < MAX_PLUGINS; ++i)
    {
        const uint32_t ver = pendingVersions[(size_t) i].load(std::memory_order_acquire);
        if (ver != seenVersions[(size_t) i])
        {
            activeSlots[(size_t) i].store(pendingSlots[(size_t) i].load(std::memory_order_acquire));
            seenVersions[(size_t) i] = ver;
        }
    }

    if (muted.load() || soloMuted.load() || ! monitoring.load())
    {
        float peak = 0.0f;
        for (int i = 0; i < numSamples; ++i) peak = juce::jmax(peak, std::abs(inSamples[i]));
        if (peak > inPeak.load()) inPeak.store(peak);
        return;
    }

    // Input peak.
    {
        float peak = 0.0f;
        for (int i = 0; i < numSamples; ++i) peak = juce::jmax(peak, std::abs(inSamples[i]));
        if (peak > inPeak.load()) inPeak.store(peak);
    }

    auto* pluginInL = pluginBuffer.getWritePointer(0);
    auto* pluginInR = pluginBuffer.getWritePointer(1);

    // Stage 1: copy mono input into stereo plugin buffer (mono → both channels).
    for (int i = 0; i < numSamples; ++i)
    {
        const float s = inSamples[i];
        pluginInL[i] = s;
        pluginInR[i] = s;
    }

    // Stage 2: run plugin chain in-place. Each plugin gets stereo in/out via pluginBuffer.
    // Bypassed slots are skipped — audio passes through untouched.
    for (int i = 0; i < MAX_PLUGINS; ++i)
    {
        if (bypassedSlots[(size_t) i].load()) continue;
        if (auto* p = activeSlots[(size_t) i].load())
            p->processBlock(pluginBuffer, emptyMidi);
    }

    // Stage 3: apply gain + pan, sum into the stereo bus.
    const float targetGain = targetGainLinear.load();
    const float targetP    = targetPan.load();
    const float gainStep   = (targetGain - currentGainLinear) / static_cast<float>(numSamples);
    const float panStep    = (targetP   - currentPan)         / static_cast<float>(numSamples);

    float g = currentGainLinear;
    float pan = currentPan;
    float maxL = 0.0f, maxR = 0.0f;
    for (int i = 0; i < numSamples; ++i)
    {
        const float l = pluginBuffer.getSample(0, i);
        const float r = pluginBuffer.getSample(1, i);
        const float angle = (pan + 1.0f) * 0.25f * juce::MathConstants<float>::pi;
        const float lGain = std::cos(angle);
        const float rGain = std::sin(angle);

        const float ol = l * g * lGain;
        const float orr = r * g * rGain;

        outL[i] += ol;
        outR[i] += orr;

        maxL = juce::jmax(maxL, std::abs(ol));
        maxR = juce::jmax(maxR, std::abs(orr));

        g   += gainStep;
        pan += panStep;
    }

    currentGainLinear = targetGain;
    currentPan        = targetP;

    if (maxL > outPeakL.load()) outPeakL.store(maxL);
    if (maxR > outPeakR.load()) outPeakR.store(maxR);
}

void ChannelStrip::processStereo(const float* inL, const float* inR, float* outL, float* outR, int numSamples)
{
    // Hot-swap pending → active for any slot whose version changed.
    for (int i = 0; i < MAX_PLUGINS; ++i)
    {
        const uint32_t ver = pendingVersions[(size_t) i].load(std::memory_order_acquire);
        if (ver != seenVersions[(size_t) i])
        {
            activeSlots[(size_t) i].store(pendingSlots[(size_t) i].load(std::memory_order_acquire));
            seenVersions[(size_t) i] = ver;
        }
    }

    // Input peak (per-channel for buses + combined for compatibility).
    {
        float peakL = 0.0f, peakR = 0.0f;
        for (int i = 0; i < numSamples; ++i)
        {
            const float al = std::abs(inL[i]);
            const float ar = std::abs(inR[i]);
            if (al > peakL) peakL = al;
            if (ar > peakR) peakR = ar;
        }
        if (peakL > inPeakL.load()) inPeakL.store(peakL);
        if (peakR > inPeakR.load()) inPeakR.store(peakR);
        const float maxLR = juce::jmax(peakL, peakR);
        if (maxLR > inPeak.load()) inPeak.store(maxLR);
    }

    if (muted.load()) return;

    auto* pluginInL = pluginBuffer.getWritePointer(0);
    auto* pluginInR = pluginBuffer.getWritePointer(1);

    // Stage 1: copy stereo input into plugin buffer.
    juce::FloatVectorOperations::copy(pluginInL, inL, numSamples);
    juce::FloatVectorOperations::copy(pluginInR, inR, numSamples);

    // Stage 2: run plugin chain. Bypassed slots are skipped.
    for (int i = 0; i < MAX_PLUGINS; ++i)
    {
        if (bypassedSlots[(size_t) i].load()) continue;
        if (auto* p = activeSlots[(size_t) i].load())
            p->processBlock(pluginBuffer, emptyMidi);
    }

    // Stage 3: apply gain + pan, sum into output bus.
    const float targetGain = targetGainLinear.load();
    const float targetP    = targetPan.load();
    const float gainStep   = (targetGain - currentGainLinear) / static_cast<float>(numSamples);
    const float panStep    = (targetP   - currentPan)         / static_cast<float>(numSamples);

    float g = currentGainLinear;
    float pan = currentPan;
    float maxL = 0.0f, maxR = 0.0f;
    for (int i = 0; i < numSamples; ++i)
    {
        const float l = pluginBuffer.getSample(0, i);
        const float r = pluginBuffer.getSample(1, i);
        const float angle = (pan + 1.0f) * 0.25f * juce::MathConstants<float>::pi;
        const float lGain = std::cos(angle);
        const float rGain = std::sin(angle);

        const float ol = l * g * lGain;
        const float orr = r * g * rGain;

        outL[i] += ol;
        outR[i] += orr;

        maxL = juce::jmax(maxL, std::abs(ol));
        maxR = juce::jmax(maxR, std::abs(orr));

        g   += gainStep;
        pan += panStep;
    }

    currentGainLinear = targetGain;
    currentPan        = targetP;

    if (maxL > outPeakL.load()) outPeakL.store(maxL);
    if (maxR > outPeakR.load()) outPeakR.store(maxR);
}
