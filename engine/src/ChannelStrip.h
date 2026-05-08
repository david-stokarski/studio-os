#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <atomic>
#include <array>
#include <memory>

class ChannelStrip
{
public:
    // Soft cap — large enough to feel uncapped from the UI's perspective.
    // The arrays below are fixed-size for lock-free audio-thread reads.
    static constexpr int MAX_PLUGINS = 32;

    ChannelStrip();
    ~ChannelStrip();

    void prepare(double sampleRate, int blockSize);
    void release();

    // Process a single mono input source into a stereo output bus.
    void process(const float* inSamples, float* outL, float* outR, int numSamples);

    // Process a stereo input through the plugin chain + gain/pan, summing into outL/outR.
    // Used by Bus strips, which receive pre-summed stereo audio from routed tracks.
    // Skips the monitor/solo gates — buses always emit unless muted.
    void processStereo(const float* inL, const float* inR, float* outL, float* outR, int numSamples);

    // Real-time-safe parameter updates.
    void setGainDb(float db) noexcept   { targetGainLinear.store(juce::Decibels::decibelsToGain(db, -60.0f)); }
    void setPan(float p) noexcept       { targetPan.store(juce::jlimit(-1.0f, 1.0f, p)); }
    void setMute(bool m) noexcept       { muted.store(m); }
    void setMonitor(bool on) noexcept   { monitoring.store(on); }
    void setSolo(bool s) noexcept       { soloed.store(s); }
    void setSoloMute(bool m) noexcept   { soloMuted.store(m); }

    bool isMonitoring() const noexcept { return monitoring.load(); }
    bool isSoloed() const noexcept     { return soloed.load(); }

    // Plugin chain (per slot, max MAX_PLUGINS). slot ∈ [0, MAX_PLUGINS).
    // setPluginAt(slot, nullptr, ...) clears that slot.
    void setPluginAt(int slot, std::unique_ptr<juce::AudioPluginInstance> plugin, double sampleRate, int blockSize,
                     const juce::MemoryBlock& state = {});
    void clearSlot(int slot);
    // Reorder: move the plugin currently at fromSlot into toSlot, shifting
    // intermediate slots toward the gap. Plugin instances are preserved (no
    // re-instantiation, no state loss); the audio thread picks up the new
    // chain order on the next buffer via per-slot version sentinels.
    void moveSlot(int fromSlot, int toSlot);
    juce::AudioPluginInstance* getPluginAt(int slot) const noexcept;
    int getNumActivePlugins() const noexcept;
    int getMaxPlugins() const noexcept { return MAX_PLUGINS; }

    void setSlotBypassed(int slot, bool b) noexcept
    {
        if (slot >= 0 && slot < MAX_PLUGINS) bypassedSlots[(size_t) slot].store(b);
    }
    bool isSlotBypassed(int slot) const noexcept
    {
        return slot >= 0 && slot < MAX_PLUGINS && bypassedSlots[(size_t) slot].load();
    }

    // Peak meters (post-fader, post-plugin).
    // For mono `process` (tracks): inPeak holds the single mono input peak.
    // For `processStereo` (buses): inPeakL / inPeakR hold per-channel input peaks.
    float getInputPeak() noexcept   { return inPeak.exchange(0.0f); }
    float getInputPeakL() noexcept  { return inPeakL.exchange(0.0f); }
    float getInputPeakR() noexcept  { return inPeakR.exchange(0.0f); }
    float getOutputPeakL() noexcept { return outPeakL.exchange(0.0f); }
    float getOutputPeakR() noexcept { return outPeakR.exchange(0.0f); }

private:
    std::atomic<float> targetGainLinear { 1.0f };
    std::atomic<float> targetPan { 0.0f };
    std::atomic<bool>  muted { false };
    std::atomic<bool>  monitoring { false };
    std::atomic<bool>  soloed { false };
    std::atomic<bool>  soloMuted { false }; // set by AudioEngine when other tracks are soloed

    float currentGainLinear = 1.0f;
    float currentPan = 0.0f;

    std::atomic<float> inPeak { 0.0f };
    std::atomic<float> inPeakL { 0.0f };
    std::atomic<float> inPeakR { 0.0f };
    std::atomic<float> outPeakL { 0.0f };
    std::atomic<float> outPeakR { 0.0f };

    // For each slot:
    //   activeSlots[i] is what the audio thread reads.
    //   pendingSlots[i] is set by message thread; audio thread swaps it into active.
    //   ownedSlots[i] holds ownership matching activeSlots[i].
    //   retiredSlots[i] holds the previous owner until message thread cleans it up.
    std::array<std::atomic<juce::AudioPluginInstance*>, MAX_PLUGINS> activeSlots {};
    std::array<std::atomic<juce::AudioPluginInstance*>, MAX_PLUGINS> pendingSlots {};
    std::array<std::unique_ptr<juce::AudioPluginInstance>, MAX_PLUGINS> ownedSlots;
    std::array<std::unique_ptr<juce::AudioPluginInstance>, MAX_PLUGINS> retiredSlots;
    // Sentinel atomic: bumped by message thread when pendingSlots[i] is updated, so
    // the audio thread knows to look (otherwise pending==active means "no change").
    std::array<std::atomic<uint32_t>, MAX_PLUGINS> pendingVersions {};
    std::array<uint32_t, MAX_PLUGINS> seenVersions {};
    std::array<std::atomic<bool>, MAX_PLUGINS> bypassedSlots {};

    juce::AudioBuffer<float> pluginBuffer;
    juce::MidiBuffer emptyMidi;

    double sr = 48000.0;
    int    bs = 512;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(ChannelStrip)
};
