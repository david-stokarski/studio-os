#pragma once

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include "ChannelStrip.h"
#include "PluginHost.h"

#include <memory>
#include <vector>
#include <array>
#include <mutex>

// A "Track" is a user-created audio path: one mono input channel, one stereo
// output pair, and a ChannelStrip handling gain/pan/mute/monitor + plugins.
// Tracks are addressed by stable string id assigned by the UI.
class AudioEngine : public juce::AudioIODeviceCallback
{
public:
    AudioEngine();
    ~AudioEngine() override;

    // Device management.
    juce::Array<juce::AudioIODeviceType*> getDeviceTypes();
    juce::StringArray getInputDeviceNames();
    juce::StringArray getOutputDeviceNames();

    juce::String setAudioDevice(const juce::String& inputName,
                                const juce::String& outputName,
                                double sampleRate, int bufferSize,
                                int numInputChannels);

    juce::String getCurrentInputDevice() const;
    juce::String getCurrentOutputDevice() const;
    double       getCurrentSampleRate() const;
    int          getCurrentBufferSize() const;
    int          getNumActiveInputs() const;
    int          getNumActiveOutputs() const;

    // Track ops.
    juce::String addTrack(const juce::String& id, const juce::String& name,
                          int inputCh, int outL, int outR);
    void removeTrack(const juce::String& id);
    void setTrackInput(const juce::String& id, int inputCh);
    void setTrackOutput(const juce::String& id, int outL, int outR);
    // Route a track to a bus (busId non-empty) or back to master output (busId empty).
    void setTrackBus(const juce::String& id, const juce::String& busId);

    void setTrackGainDb(const juce::String& id, float db);
    void setTrackPan(const juce::String& id, float p);
    void setTrackMute(const juce::String& id, bool m);
    void setTrackMonitor(const juce::String& id, bool on);
    void setTrackSolo(const juce::String& id, bool s);

    // Bus ops. A bus aggregates audio from any number of tracks routed to it,
    // runs them through a plugin chain, then sums the result into the master output pair.
    juce::String addBus(const juce::String& id, const juce::String& name, int outL, int outR);
    void removeBus(const juce::String& id);
    void setBusOutput(const juce::String& id, int outL, int outR);
    void setBusGainDb(const juce::String& id, float db);
    void setBusPan(const juce::String& id, float p);
    void setBusMute(const juce::String& id, bool m);

    PluginHost& plugins() noexcept { return pluginHost; }
    juce::String loadPluginOnTrack(const juce::String& id, int slot, const juce::String& identifierString,
                                   const juce::String& stateBase64 = {});
    void clearPluginOnTrack(const juce::String& id, int slot);
    void setPluginBypassedOnTrack(const juce::String& id, int slot, bool bypassed);
    void reorderPluginOnTrack(const juce::String& id, int fromSlot, int toSlot);
    bool showPluginEditor(const juce::String& id, int slot);
    void hidePluginEditor(const juce::String& id, int slot);
    juce::String getPluginState(const juce::String& id, int slot); // base64

    juce::String loadPluginOnBus(const juce::String& id, int slot, const juce::String& identifierString,
                                 const juce::String& stateBase64 = {});
    void clearPluginOnBus(const juce::String& id, int slot);
    void setPluginBypassedOnBus(const juce::String& id, int slot, bool bypassed);
    void reorderPluginOnBus(const juce::String& id, int fromSlot, int toSlot);
    bool showBusPluginEditor(const juce::String& id, int slot);
    void hideBusPluginEditor(const juce::String& id, int slot);
    juce::String getBusPluginState(const juce::String& id, int slot);

    struct TrackMeter {
        juce::String id;
        float in;
        float outL;
        float outR;
        bool monitoring;
    };
    struct BusMeter {
        juce::String id;
        float inL;
        float inR;
        float outL;
        float outR;
    };
    std::vector<TrackMeter> snapshotMeters();
    std::vector<BusMeter>   snapshotBusMeters();

    juce::var captureState();
    juce::String applyState(const juce::var& state);

    void audioDeviceIOCallbackWithContext (const float* const* inputChannelData,
                                           int numInputChannels,
                                           float* const* outputChannelData,
                                           int numOutputChannels,
                                           int numSamples,
                                           const juce::AudioIODeviceCallbackContext& context) override;

    void audioDeviceAboutToStart(juce::AudioIODevice* device) override;
    void audioDeviceStopped() override;

private:
    struct EditorWindow;
    struct Track {
        juce::String id;
        juce::String name;
        int inputCh = 0;
        int outL = 0;
        int outR = 1;
        juce::String busId; // empty = route to master
        std::unique_ptr<ChannelStrip> strip;
        std::array<std::unique_ptr<EditorWindow>, ChannelStrip::MAX_PLUGINS> editors;
        Track();
        ~Track();
    };

    struct Bus {
        juce::String id;
        juce::String name;
        int outL = 0;
        int outR = 1;
        std::unique_ptr<ChannelStrip> strip;
        std::array<std::unique_ptr<EditorWindow>, ChannelStrip::MAX_PLUGINS> editors;
        // Stereo accumulator for tracks routed to this bus. Cleared at the start
        // of each audio callback; routed tracks sum into it; the bus's plugin
        // chain processes it and the result is summed into the master output.
        juce::AudioBuffer<float> accum;
        Bus();
        ~Bus();
    };

    std::unique_ptr<juce::AudioDeviceManager> deviceManager;
    PluginHost pluginHost;

    // tracksMutex guards the tracks vector size/order. Per-track parameter
    // updates are atomic inside ChannelStrip and don't take this lock.
    // The audio thread reads the vector without locking; we never reallocate
    // mid-stream because addTrack/removeTrack are called from the message
    // thread between audio buffers, and the vector's pointer arrays are
    // stable (we use unique_ptr<Track> elements).
    std::mutex tracksMutex;
    std::vector<std::unique_ptr<Track>> tracks;
    std::vector<std::unique_ptr<Bus>>   buses;

    int activeInputCount = 0;
    int activeOutputCount = 0;
    double sr = 48000.0;
    int    bs = 256;

    Track* findTrack(const juce::String& id);
    Bus*   findBus(const juce::String& id);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AudioEngine)
};
