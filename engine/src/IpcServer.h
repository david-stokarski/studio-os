#pragma once

#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <atomic>
#include <thread>
#include "AudioEngine.h"

// Reads newline-delimited JSON commands from stdin and writes responses/events to stdout.
// All command handling marshals to the message thread before touching the engine.
class IpcServer : private juce::Timer
{
public:
    IpcServer(AudioEngine& engine);
    ~IpcServer();

    void start();
    void stop();

private:
    AudioEngine& engine;

    std::thread reader;
    std::atomic<bool> running { false };

    void readerLoop();
    void handleLine(const juce::String& line);
    void writeJson(const juce::var& value);
    void emitEvent(const juce::String& name, const juce::var& data);

    juce::var handleCommand(const juce::String& cmd, const juce::var& args, juce::String& errorOut);

    // meter timer
    void timerCallback() override;
};
