#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <memory>

// Discovers and instantiates AudioUnit plugins on macOS.
class PluginHost
{
public:
    PluginHost();

    using ProgressCallback = std::function<void(int current, int total, const juce::String& name)>;

    // Scan the system AU plugin directories. Updates internal known list and
    // writes a cache file. The callback may be invoked from worker threads.
    int scan(ProgressCallback onProgress = {}, int numThreads = 0);

    // Load cached scan results from disk. Returns true if any were loaded.
    bool loadCache();

    // Persist the current known list to disk.
    bool saveCache();

    // Cache file location.
    static juce::File getCacheFile();

    // The cached list of discovered plugins.
    const juce::KnownPluginList& getKnownList() const noexcept { return knownList; }

    // Instantiate a plugin by its identifierString. Returns nullptr on failure.
    std::unique_ptr<juce::AudioPluginInstance> createInstance(const juce::String& identifierString,
                                                              double sampleRate, int blockSize,
                                                              juce::String& errorMessage);

private:
    juce::AudioPluginFormatManager formatManager;
    juce::KnownPluginList knownList;
};
