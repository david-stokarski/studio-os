#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>
#include <juce_audio_devices/juce_audio_devices.h>

#include "AudioEngine.h"
#include "IpcServer.h"

class EngineApp : public juce::JUCEApplication
{
public:
    const juce::String getApplicationName() override     { return "AudioEngine"; }
    const juce::String getApplicationVersion() override  { return "0.1.0"; }
    bool moreThanOneInstanceAllowed() override           { return true; }

    void initialise(const juce::String&) override
    {
        // Console-mode JUCE apps don't activate as a Cocoa GUI app, so AU plugin
        // editor NSWindows would never be shown. This promotes us to a regular
        // foreground process so DocumentWindow can present windows normally.
        juce::Process::makeForegroundProcess();

        engine = std::make_unique<AudioEngine>();
        ipc    = std::make_unique<IpcServer>(*engine);
        ipc->start();

        // Emit a ready event so the host knows we're up.
        auto* o = new juce::DynamicObject();
        o->setProperty("event", "ready");
        std::cout << juce::JSON::toString(juce::var(o), true).toStdString() << "\n";
        std::cout.flush();
    }

    void shutdown() override
    {
        if (ipc) ipc->stop();
        ipc.reset();
        engine.reset();
    }

    void systemRequestedQuit() override { quit(); }

private:
    std::unique_ptr<AudioEngine> engine;
    std::unique_ptr<IpcServer>   ipc;
};

START_JUCE_APPLICATION(EngineApp)
