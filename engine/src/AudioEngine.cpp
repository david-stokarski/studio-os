#include "AudioEngine.h"
#include <juce_gui_basics/juce_gui_basics.h>

struct AudioEngine::EditorWindow : public juce::DocumentWindow
{
    EditorWindow(const juce::String& name, juce::AudioProcessorEditor* editor)
        : juce::DocumentWindow(name,
                               juce::Colours::darkgrey,
                               juce::DocumentWindow::closeButton | juce::DocumentWindow::minimiseButton)
    {
        setUsingNativeTitleBar(true);
        setContentOwned(editor, true);
        setResizable(editor->isResizable(), false);
        centreWithSize(editor->getWidth(), editor->getHeight());
        // Float above the host (Tauri) window so the editor is always reachable.
        setAlwaysOnTop(true);
        setVisible(true);
    }

    void closeButtonPressed() override { setVisible(false); }
};

AudioEngine::Track::Track() = default;
AudioEngine::Track::~Track() = default;
AudioEngine::Bus::Bus() = default;
AudioEngine::Bus::~Bus() = default;

AudioEngine::AudioEngine()
{
    deviceManager = std::make_unique<juce::AudioDeviceManager>();
    pluginHost.loadCache();

    // Create the master output bus — always present. All audio flows through it
    // before reaching the physical outputs. Sub-buses sum into master's input;
    // tracks default to routing into master when no sub-bus is assigned.
    auto master = std::make_unique<Bus>();
    master->id = "master";
    master->name = "Master";
    master->outL = 0;
    master->outR = 1;
    master->strip = std::make_unique<ChannelStrip>();
    master->strip->prepare(sr, bs);
    master->strip->setMonitor(true);
    master->accum.setSize(2, juce::jmax(bs, 1), false, true, true);
    buses.push_back(std::move(master));
}

AudioEngine::~AudioEngine()
{
    if (deviceManager)
    {
        deviceManager->removeAudioCallback(this);
        deviceManager->closeAudioDevice();
    }
    tracks.clear();
    buses.clear();
}

juce::Array<juce::AudioIODeviceType*> AudioEngine::getDeviceTypes()
{
    juce::Array<juce::AudioIODeviceType*> out;
    for (auto* t : deviceManager->getAvailableDeviceTypes())
    {
        t->scanForDevices();
        out.add(t);
    }
    return out;
}

juce::StringArray AudioEngine::getInputDeviceNames()
{
    juce::StringArray out;
    for (auto* t : getDeviceTypes())
        for (auto& n : t->getDeviceNames(true))
            out.addIfNotAlreadyThere(n);
    return out;
}

juce::StringArray AudioEngine::getOutputDeviceNames()
{
    juce::StringArray out;
    for (auto* t : getDeviceTypes())
        for (auto& n : t->getDeviceNames(false))
            out.addIfNotAlreadyThere(n);
    return out;
}

juce::String AudioEngine::setAudioDevice(const juce::String& inputName,
                                         const juce::String& outputName,
                                         double sampleRate, int bufferSize,
                                         int numInputChannels)
{
    deviceManager->removeAudioCallback(this);

    juce::AudioDeviceManager::AudioDeviceSetup setup;
    deviceManager->getAudioDeviceSetup(setup);

    setup.inputDeviceName  = inputName;
    setup.outputDeviceName = outputName.isEmpty() ? inputName : outputName;
    setup.sampleRate       = sampleRate;
    setup.bufferSize       = bufferSize;
    setup.useDefaultInputChannels  = false;
    setup.useDefaultOutputChannels = true;

    juce::BigInteger inMask;
    inMask.setRange(0, juce::jmax(1, numInputChannels), true);
    setup.inputChannels = inMask;

    auto err = deviceManager->setAudioDeviceSetup(setup, true);
    if (err.isNotEmpty())
        return err;

    if (auto* dev = deviceManager->getCurrentAudioDevice())
    {
        sr = dev->getCurrentSampleRate();
        bs = dev->getCurrentBufferSizeSamples();
        activeInputCount  = dev->getActiveInputChannels().countNumberOfSetBits();
        activeOutputCount = dev->getActiveOutputChannels().countNumberOfSetBits();
        std::lock_guard<std::mutex> lk(tracksMutex);
        for (auto& t : tracks) t->strip->prepare(sr, bs);
        for (auto& b : buses)
        {
            b->strip->prepare(sr, bs);
            b->accum.setSize(2, bs, false, true, true);
        }
    }

    deviceManager->addAudioCallback(this);
    return {};
}

juce::String AudioEngine::getCurrentInputDevice() const
{
    juce::AudioDeviceManager::AudioDeviceSetup s;
    deviceManager->getAudioDeviceSetup(s);
    return s.inputDeviceName;
}
juce::String AudioEngine::getCurrentOutputDevice() const
{
    juce::AudioDeviceManager::AudioDeviceSetup s;
    deviceManager->getAudioDeviceSetup(s);
    return s.outputDeviceName;
}
double AudioEngine::getCurrentSampleRate() const { return sr; }
int    AudioEngine::getCurrentBufferSize() const { return bs; }
int    AudioEngine::getNumActiveInputs()  const  { return activeInputCount; }
int    AudioEngine::getNumActiveOutputs() const  { return activeOutputCount; }

AudioEngine::Track* AudioEngine::findTrack(const juce::String& id)
{
    for (auto& t : tracks)
        if (t->id == id) return t.get();
    return nullptr;
}

AudioEngine::Bus* AudioEngine::findBus(const juce::String& id)
{
    for (auto& b : buses)
        if (b->id == id) return b.get();
    return nullptr;
}

juce::String AudioEngine::addTrack(const juce::String& id, const juce::String& name,
                                   int inputCh, int outL, int outR)
{
    std::lock_guard<std::mutex> lk(tracksMutex);
    if (id.isEmpty()) return "Track id required";
    for (auto& t : tracks) if (t->id == id) return "Track id already exists";

    auto track = std::make_unique<Track>();
    track->id = id;
    track->name = name;
    track->inputCh = juce::jmax(0, inputCh);
    track->outL = juce::jmax(0, outL);
    track->outR = juce::jmax(0, outR);
    track->strip = std::make_unique<ChannelStrip>();
    track->strip->prepare(sr, bs);
    tracks.push_back(std::move(track));
    return {};
}

void AudioEngine::removeTrack(const juce::String& id)
{
    std::lock_guard<std::mutex> lk(tracksMutex);
    tracks.erase(std::remove_if(tracks.begin(), tracks.end(),
                                [&](const std::unique_ptr<Track>& t) { return t->id == id; }),
                 tracks.end());
}

void AudioEngine::setTrackInput(const juce::String& id, int inputCh)
{
    std::lock_guard<std::mutex> lk(tracksMutex);
    if (auto* t = findTrack(id)) t->inputCh = juce::jmax(0, inputCh);
}

void AudioEngine::setTrackOutput(const juce::String& id, int outL, int outR)
{
    std::lock_guard<std::mutex> lk(tracksMutex);
    if (auto* t = findTrack(id)) { t->outL = juce::jmax(0, outL); t->outR = juce::jmax(0, outR); }
}

void AudioEngine::setTrackBus(const juce::String& id, const juce::String& busId)
{
    std::lock_guard<std::mutex> lk(tracksMutex);
    if (auto* t = findTrack(id)) t->busId = busId;
}

void AudioEngine::setTrackGainDb(const juce::String& id, float db)
{
    if (auto* t = findTrack(id)) t->strip->setGainDb(db);
}
void AudioEngine::setTrackPan(const juce::String& id, float p)
{
    if (auto* t = findTrack(id)) t->strip->setPan(p);
}
void AudioEngine::setTrackMute(const juce::String& id, bool m)
{
    if (auto* t = findTrack(id)) t->strip->setMute(m);
}
void AudioEngine::setTrackMonitor(const juce::String& id, bool on)
{
    if (auto* t = findTrack(id)) t->strip->setMonitor(on);
}

void AudioEngine::setTrackSolo(const juce::String& id, bool s)
{
    std::lock_guard<std::mutex> lk(tracksMutex);
    if (auto* t = findTrack(id)) t->strip->setSolo(s);
    bool anySoloed = false;
    for (auto& tr : tracks) if (tr->strip->isSoloed()) { anySoloed = true; break; }
    for (auto& tr : tracks) tr->strip->setSoloMute(anySoloed && ! tr->strip->isSoloed());
}

juce::String AudioEngine::addBus(const juce::String& id, const juce::String& name, int outL, int outR)
{
    std::lock_guard<std::mutex> lk(tracksMutex);
    if (id.isEmpty()) return "Bus id required";
    // Special-case master: idempotent so the frontend can always call addBus("master")
    // on startup without having to know whether the engine already has it.
    if (id == "master")
        for (auto& b : buses) if (b->id == "master") return {};
    for (auto& b : buses) if (b->id == id) return "Bus id already exists";

    auto bus = std::make_unique<Bus>();
    bus->id = id;
    bus->name = name;
    bus->outL = juce::jmax(0, outL);
    bus->outR = juce::jmax(0, outR);
    bus->strip = std::make_unique<ChannelStrip>();
    bus->strip->prepare(sr, bs);
    bus->strip->setMonitor(true); // bus is always "live"
    bus->accum.setSize(2, juce::jmax(bs, 1), false, true, true);
    buses.push_back(std::move(bus));
    return {};
}

void AudioEngine::removeBus(const juce::String& id)
{
    std::lock_guard<std::mutex> lk(tracksMutex);
    if (id == "master") return; // protected — master cannot be removed
    // Reset any tracks routed here back to master so audio doesn't drop into a void.
    for (auto& t : tracks)
        if (t->busId == id) t->busId.clear();
    buses.erase(std::remove_if(buses.begin(), buses.end(),
                               [&](const std::unique_ptr<Bus>& b) { return b->id == id; }),
                buses.end());
}

void AudioEngine::setBusOutput(const juce::String& id, int outL, int outR)
{
    std::lock_guard<std::mutex> lk(tracksMutex);
    if (auto* b = findBus(id)) { b->outL = juce::jmax(0, outL); b->outR = juce::jmax(0, outR); }
}

void AudioEngine::setBusGainDb(const juce::String& id, float db)
{
    if (auto* b = findBus(id)) b->strip->setGainDb(db);
}
void AudioEngine::setBusPan(const juce::String& id, float p)
{
    if (auto* b = findBus(id)) b->strip->setPan(p);
}
void AudioEngine::setBusMute(const juce::String& id, bool m)
{
    if (auto* b = findBus(id)) b->strip->setMute(m);
}

juce::String AudioEngine::loadPluginOnTrack(const juce::String& id, int slot, const juce::String& identifierString,
                                            const juce::String& stateBase64)
{
    auto* t = findTrack(id);
    if (! t) return "Invalid track";
    if (slot < 0 || slot >= ChannelStrip::MAX_PLUGINS) return "Invalid slot";

    juce::String err;
    auto inst = pluginHost.createInstance(identifierString, sr, bs, err);
    if (! inst) return err.isEmpty() ? juce::String("Failed to instantiate plugin") : err;

    // Decode state and pass through to setPluginAt so it's applied AFTER prepareToPlay.
    // Calling setStateInformation on an unprepared plugin segfaults (uncatchable).
    juce::MemoryBlock state;
    if (stateBase64.isNotEmpty()) state.fromBase64Encoding(stateBase64);

    if (t->editors[(size_t) slot]) t->editors[(size_t) slot].reset();
    t->strip->setPluginAt(slot, std::move(inst), sr, bs, state);
    return {};
}

juce::String AudioEngine::getPluginState(const juce::String& id, int slot)
{
    auto* t = findTrack(id);
    if (! t) return {};
    if (slot < 0 || slot >= ChannelStrip::MAX_PLUGINS) return {};
    auto* p = t->strip->getPluginAt(slot);
    if (! p) return {};
    juce::MemoryBlock mb;
    try { p->getStateInformation(mb); }
    catch (...) { return {}; }
    return mb.toBase64Encoding();
}

void AudioEngine::clearPluginOnTrack(const juce::String& id, int slot)
{
    auto* t = findTrack(id);
    if (! t) return;
    if (slot < 0 || slot >= ChannelStrip::MAX_PLUGINS) return;
    if (t->editors[(size_t) slot]) t->editors[(size_t) slot].reset();
    t->strip->clearSlot(slot);
}

void AudioEngine::setPluginBypassedOnTrack(const juce::String& id, int slot, bool bypassed)
{
    auto* t = findTrack(id);
    if (! t) return;
    t->strip->setSlotBypassed(slot, bypassed);
}

void AudioEngine::reorderPluginOnTrack(const juce::String& id, int fromSlot, int toSlot)
{
    auto* t = findTrack(id);
    if (! t) return;
    if (fromSlot == toSlot) return;
    if (fromSlot < 0 || fromSlot >= ChannelStrip::MAX_PLUGINS) return;
    if (toSlot   < 0 || toSlot   >= ChannelStrip::MAX_PLUGINS) return;

    // Editor windows are indexed by slot — they must follow the moved plugin
    // so an open editor remains attached to the same plugin instance after reorder.
    auto movedEditor = std::move(t->editors[(size_t) fromSlot]);
    if (fromSlot < toSlot)
        for (int i = fromSlot; i < toSlot; ++i)
            t->editors[(size_t) i] = std::move(t->editors[(size_t) (i + 1)]);
    else
        for (int i = fromSlot; i > toSlot; --i)
            t->editors[(size_t) i] = std::move(t->editors[(size_t) (i - 1)]);
    t->editors[(size_t) toSlot] = std::move(movedEditor);

    t->strip->moveSlot(fromSlot, toSlot);
}

bool AudioEngine::showPluginEditor(const juce::String& id, int slot)
{
    auto* t = findTrack(id);
    if (! t) return false;
    if (slot < 0 || slot >= ChannelStrip::MAX_PLUGINS) return false;
    auto* p = t->strip->getPluginAt(slot);
    if (! p || ! p->hasEditor()) return false;

    // Activate the engine app so the editor window actually receives focus —
    // without this the host app stays in front and the plugin window is buried.
    juce::Process::makeForegroundProcess();

    auto& w = t->editors[(size_t) slot];
    if (w)
    {
        w->setVisible(true);
        w->toFront(true);
        w->grabKeyboardFocus();
        return true;
    }
    auto* edit = p->createEditorIfNeeded();
    if (! edit) return false;
    auto title = t->name + " · " + juce::String(slot + 1) + " — " + p->getName();
    w = std::make_unique<EditorWindow>(title, edit);
    w->toFront(true);
    w->grabKeyboardFocus();
    return true;
}

void AudioEngine::hidePluginEditor(const juce::String& id, int slot)
{
    auto* t = findTrack(id);
    if (! t) return;
    if (slot < 0 || slot >= ChannelStrip::MAX_PLUGINS) return;
    if (t->editors[(size_t) slot]) t->editors[(size_t) slot]->setVisible(false);
}

juce::String AudioEngine::loadPluginOnBus(const juce::String& id, int slot, const juce::String& identifierString,
                                          const juce::String& stateBase64)
{
    auto* b = findBus(id);
    if (! b) return "Invalid bus";
    if (slot < 0 || slot >= ChannelStrip::MAX_PLUGINS) return "Invalid slot";

    juce::String err;
    auto inst = pluginHost.createInstance(identifierString, sr, bs, err);
    if (! inst) return err.isEmpty() ? juce::String("Failed to instantiate plugin") : err;

    juce::MemoryBlock state;
    if (stateBase64.isNotEmpty()) state.fromBase64Encoding(stateBase64);

    if (b->editors[(size_t) slot]) b->editors[(size_t) slot].reset();
    b->strip->setPluginAt(slot, std::move(inst), sr, bs, state);
    return {};
}

void AudioEngine::clearPluginOnBus(const juce::String& id, int slot)
{
    auto* b = findBus(id);
    if (! b) return;
    if (slot < 0 || slot >= ChannelStrip::MAX_PLUGINS) return;
    if (b->editors[(size_t) slot]) b->editors[(size_t) slot].reset();
    b->strip->clearSlot(slot);
}

void AudioEngine::setPluginBypassedOnBus(const juce::String& id, int slot, bool bypassed)
{
    auto* b = findBus(id);
    if (! b) return;
    b->strip->setSlotBypassed(slot, bypassed);
}

void AudioEngine::reorderPluginOnBus(const juce::String& id, int fromSlot, int toSlot)
{
    auto* b = findBus(id);
    if (! b) return;
    if (fromSlot == toSlot) return;
    if (fromSlot < 0 || fromSlot >= ChannelStrip::MAX_PLUGINS) return;
    if (toSlot   < 0 || toSlot   >= ChannelStrip::MAX_PLUGINS) return;

    auto movedEditor = std::move(b->editors[(size_t) fromSlot]);
    if (fromSlot < toSlot)
        for (int i = fromSlot; i < toSlot; ++i)
            b->editors[(size_t) i] = std::move(b->editors[(size_t) (i + 1)]);
    else
        for (int i = fromSlot; i > toSlot; --i)
            b->editors[(size_t) i] = std::move(b->editors[(size_t) (i - 1)]);
    b->editors[(size_t) toSlot] = std::move(movedEditor);

    b->strip->moveSlot(fromSlot, toSlot);
}

bool AudioEngine::showBusPluginEditor(const juce::String& id, int slot)
{
    auto* b = findBus(id);
    if (! b) return false;
    if (slot < 0 || slot >= ChannelStrip::MAX_PLUGINS) return false;
    auto* p = b->strip->getPluginAt(slot);
    if (! p || ! p->hasEditor()) return false;

    juce::Process::makeForegroundProcess();

    auto& w = b->editors[(size_t) slot];
    if (w)
    {
        w->setVisible(true);
        w->toFront(true);
        w->grabKeyboardFocus();
        return true;
    }
    auto* edit = p->createEditorIfNeeded();
    if (! edit) return false;
    auto title = b->name + " · " + juce::String(slot + 1) + " — " + p->getName();
    w = std::make_unique<EditorWindow>(title, edit);
    w->toFront(true);
    w->grabKeyboardFocus();
    return true;
}

void AudioEngine::hideBusPluginEditor(const juce::String& id, int slot)
{
    auto* b = findBus(id);
    if (! b) return;
    if (slot < 0 || slot >= ChannelStrip::MAX_PLUGINS) return;
    if (b->editors[(size_t) slot]) b->editors[(size_t) slot]->setVisible(false);
}

juce::String AudioEngine::getBusPluginState(const juce::String& id, int slot)
{
    auto* b = findBus(id);
    if (! b) return {};
    if (slot < 0 || slot >= ChannelStrip::MAX_PLUGINS) return {};
    auto* p = b->strip->getPluginAt(slot);
    if (! p) return {};
    juce::MemoryBlock mb;
    try { p->getStateInformation(mb); }
    catch (...) { return {}; }
    return mb.toBase64Encoding();
}

std::vector<AudioEngine::TrackMeter> AudioEngine::snapshotMeters()
{
    std::vector<TrackMeter> out;
    out.reserve(tracks.size());
    for (auto& t : tracks)
    {
        TrackMeter m;
        m.id = t->id;
        m.in = t->strip->getInputPeak();
        m.outL = t->strip->getOutputPeakL();
        m.outR = t->strip->getOutputPeakR();
        m.monitoring = t->strip->isMonitoring();
        out.push_back(m);
    }
    return out;
}

std::vector<AudioEngine::BusMeter> AudioEngine::snapshotBusMeters()
{
    std::vector<BusMeter> out;
    out.reserve(buses.size());
    for (auto& b : buses)
    {
        BusMeter m;
        m.id = b->id;
        m.inL = b->strip->getInputPeakL();
        m.inR = b->strip->getInputPeakR();
        m.outL = b->strip->getOutputPeakL();
        m.outR = b->strip->getOutputPeakR();
        out.push_back(m);
    }
    return out;
}

juce::var AudioEngine::captureState()
{
    auto* obj = new juce::DynamicObject();
    juce::AudioDeviceManager::AudioDeviceSetup setup;
    deviceManager->getAudioDeviceSetup(setup);
    obj->setProperty("inputDevice", setup.inputDeviceName);
    obj->setProperty("outputDevice", setup.outputDeviceName);
    obj->setProperty("sampleRate", setup.sampleRate);
    obj->setProperty("bufferSize", setup.bufferSize);
    return juce::var(obj);
}

juce::String AudioEngine::applyState(const juce::var& state)
{
    if (! state.isObject()) return "Invalid state";
    auto* obj = state.getDynamicObject();
    if (! obj) return "Invalid state object";

    auto inDev  = obj->getProperty("inputDevice").toString();
    auto outDev = obj->getProperty("outputDevice").toString();
    auto sr_    = (double) obj->getProperty("sampleRate");
    auto bs_    = (int)    obj->getProperty("bufferSize");
    if (inDev.isNotEmpty() && sr_ > 0 && bs_ > 0)
    {
        auto err = setAudioDevice(inDev, outDev, sr_, bs_, /*numInputChannels*/ 32);
        if (err.isNotEmpty()) return err;
    }
    return {};
}

void AudioEngine::audioDeviceAboutToStart(juce::AudioIODevice* device)
{
    sr = device->getCurrentSampleRate();
    bs = device->getCurrentBufferSizeSamples();
    std::lock_guard<std::mutex> lk(tracksMutex);
    for (auto& t : tracks) t->strip->prepare(sr, bs);
    for (auto& b : buses)
    {
        b->strip->prepare(sr, bs);
        b->accum.setSize(2, bs, false, true, true);
    }
}

void AudioEngine::audioDeviceStopped()
{
    std::lock_guard<std::mutex> lk(tracksMutex);
    for (auto& t : tracks) t->strip->release();
    for (auto& b : buses)  b->strip->release();
}

void AudioEngine::audioDeviceIOCallbackWithContext (const float* const* inputChannelData,
                                                    int numInputChannels,
                                                    float* const* outputChannelData,
                                                    int numOutputChannels,
                                                    int numSamples,
                                                    const juce::AudioIODeviceCallbackContext& /*context*/)
{
    // Clear all outputs first.
    for (int o = 0; o < numOutputChannels; ++o)
        if (outputChannelData[o] != nullptr)
            juce::FloatVectorOperations::clear(outputChannelData[o], numSamples);

    // Read tracks/buses without locking. addTrack/addBus/etc run on the
    // message thread between buffers; brief glitches during topology change
    // are acceptable in this app.
    //
    // Routing:
    //   tracks  → assigned sub-bus accumulator (or master accumulator if none)
    //   sub-bus → master accumulator (after its own plugin chain)
    //   master  → physical output channels (after its own plugin chain)
    // If master is somehow missing, both tracks and sub-buses fall back to
    // writing directly to their configured output channels.

    Bus* master = nullptr;
    for (auto& b : buses)
        if (b && b->id == "master") { master = b.get(); break; }

    // Stage A: clear all bus accumulators so writes below sum cleanly.
    for (auto& b : buses)
    {
        if (! b) continue;
        if (b->accum.getNumSamples() < numSamples) continue;
        b->accum.clear(0, numSamples);
    }

    // Stage B: process each track. Target = assigned sub-bus, else master, else direct out.
    for (auto& t : tracks)
    {
        if (! t) continue;
        const int inCh = t->inputCh;
        if (inCh < 0 || inCh >= numInputChannels) continue;
        const float* in = inputChannelData[inCh];
        if (in == nullptr) continue;

        Bus* target = nullptr;
        if (t->busId.isNotEmpty() && t->busId != "master")
        {
            for (auto& b : buses)
                if (b && b->id == t->busId) { target = b.get(); break; }
        }
        if (target == nullptr) target = master;

        if (target != nullptr && target->accum.getNumSamples() >= numSamples)
        {
            float* outL = target->accum.getWritePointer(0);
            float* outR = target->accum.getWritePointer(1);
            t->strip->process(in, outL, outR, numSamples);
            continue;
        }

        // Fallback path: write straight to physical outputs (only if master missing).
        const int oL = t->outL;
        const int oR = t->outR;
        if (oL < 0 || oL >= numOutputChannels) continue;
        if (oR < 0 || oR >= numOutputChannels) continue;
        float* outL = outputChannelData[oL];
        float* outR = outputChannelData[oR];
        if (outL == nullptr || outR == nullptr) continue;
        t->strip->process(in, outL, outR, numSamples);
    }

    // Stage C: sub-buses run their plugin chain and sum into master's accumulator.
    for (auto& b : buses)
    {
        if (! b) continue;
        if (b->id == "master") continue; // master is processed last
        if (b->accum.getNumSamples() < numSamples) continue;

        const float* inL = b->accum.getReadPointer(0);
        const float* inR = b->accum.getReadPointer(1);

        if (master != nullptr && master->accum.getNumSamples() >= numSamples)
        {
            float* outL = master->accum.getWritePointer(0);
            float* outR = master->accum.getWritePointer(1);
            b->strip->processStereo(inL, inR, outL, outR, numSamples);
            continue;
        }

        // Fallback: direct to outputs.
        const int oL = b->outL;
        const int oR = b->outR;
        if (oL < 0 || oL >= numOutputChannels) continue;
        if (oR < 0 || oR >= numOutputChannels) continue;
        float* outL = outputChannelData[oL];
        float* outR = outputChannelData[oR];
        if (outL == nullptr || outR == nullptr) continue;
        b->strip->processStereo(inL, inR, outL, outR, numSamples);
    }

    // Stage D: master runs its plugin chain on the summed mix and writes to physical outs.
    if (master != nullptr && master->accum.getNumSamples() >= numSamples)
    {
        const int oL = master->outL;
        const int oR = master->outR;
        if (oL >= 0 && oL < numOutputChannels && oR >= 0 && oR < numOutputChannels)
        {
            float* outL = outputChannelData[oL];
            float* outR = outputChannelData[oR];
            if (outL != nullptr && outR != nullptr)
            {
                const float* inL = master->accum.getReadPointer(0);
                const float* inR = master->accum.getReadPointer(1);
                master->strip->processStereo(inL, inR, outL, outR, numSamples);
            }
        }
    }
}
