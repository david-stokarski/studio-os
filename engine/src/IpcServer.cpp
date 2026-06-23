#include "IpcServer.h"
#include <iostream>
#include <string>

IpcServer::IpcServer(AudioEngine& e) : engine(e) {}
IpcServer::~IpcServer() { stop(); }

void IpcServer::start()
{
    running.store(true);
    reader = std::thread([this] { readerLoop(); });
    startTimer(33); // ~30 Hz meters
}

void IpcServer::stop()
{
    if (! running.exchange(false)) return;
    stopTimer();
    if (reader.joinable())
        reader.join();
}

void IpcServer::readerLoop()
{
    std::string line;
    while (running.load() && std::getline(std::cin, line))
    {
        juce::String s(line);
        juce::MessageManager::callAsync([this, s]() { handleLine(s); });
    }
    running.store(false);
    juce::MessageManager::callAsync([] { juce::JUCEApplicationBase::quit(); });
}

void IpcServer::writeJson(const juce::var& value)
{
    auto json = juce::JSON::toString(value, true);
    static std::mutex out;
    std::lock_guard<std::mutex> lk(out);
    std::cout << json.toStdString() << "\n";
    std::cout.flush();
}

void IpcServer::emitEvent(const juce::String& name, const juce::var& data)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("event", name);
    obj->setProperty("data", data);
    writeJson(juce::var(obj));
}

void IpcServer::handleLine(const juce::String& line)
{
    if (line.trim().isEmpty()) return;

    juce::var parsed;
    auto result = juce::JSON::parse(line, parsed);
    if (result.failed() || ! parsed.isObject())
    {
        emitEvent("log", juce::var("Bad JSON: " + line));
        return;
    }

    auto id   = parsed["id"].toString();
    auto cmd  = parsed["cmd"].toString();
    auto args = parsed["args"];

    juce::String err;
    juce::var result_val;
    try
    {
        result_val = handleCommand(cmd, args, err);
    }
    catch (const std::exception& e)
    {
        err = juce::String("Exception: ") + e.what();
    }
    catch (...)
    {
        err = "Unknown exception";
    }

    auto* resp = new juce::DynamicObject();
    resp->setProperty("id", id);
    if (err.isEmpty())
    {
        resp->setProperty("ok", true);
        resp->setProperty("result", result_val);
    }
    else
    {
        resp->setProperty("ok", false);
        resp->setProperty("error", err);
    }
    writeJson(juce::var(resp));
}

static juce::var pluginListToVar(const juce::KnownPluginList& list)
{
    juce::Array<juce::var> arr;
    for (auto& d : list.getTypes())
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("id", d.createIdentifierString());
        obj->setProperty("name", d.name);
        obj->setProperty("manufacturer", d.manufacturerName);
        obj->setProperty("category", d.category);
        obj->setProperty("format", d.pluginFormatName);
        obj->setProperty("isInstrument", d.isInstrument);
        arr.add(juce::var(obj));
    }
    return juce::var(arr);
}

juce::var IpcServer::handleCommand(const juce::String& cmd, const juce::var& args, juce::String& errorOut)
{
    if (cmd == "ping")
    {
        return juce::var("pong");
    }
    if (cmd == "listAudioDevices")
    {
        auto* o = new juce::DynamicObject();
        juce::Array<juce::var> ins, outs;
        for (auto& n : engine.getInputDeviceNames())  ins.add(juce::var(n));
        for (auto& n : engine.getOutputDeviceNames()) outs.add(juce::var(n));
        o->setProperty("inputs", ins);
        o->setProperty("outputs", outs);
        o->setProperty("currentInput", engine.getCurrentInputDevice());
        o->setProperty("currentOutput", engine.getCurrentOutputDevice());
        o->setProperty("sampleRate", engine.getCurrentSampleRate());
        o->setProperty("bufferSize", engine.getCurrentBufferSize());
        o->setProperty("numActiveInputs", engine.getNumActiveInputs());
        o->setProperty("numActiveOutputs", engine.getNumActiveOutputs());
        o->setProperty("inputLatencySamples", engine.getInputLatencySamples());
        o->setProperty("outputLatencySamples", engine.getOutputLatencySamples());
        return juce::var(o);
    }
    if (cmd == "setAudioDevice")
    {
        auto inName  = args["input"].toString();
        auto outName = args["output"].toString();
        double srArg = (double) args["sampleRate"];
        int    bsArg = (int)    args["bufferSize"];
        int    nIn   = (int)    args["numInputChannels"];
        if (srArg <= 0) srArg = 48000.0;
        if (bsArg <= 0) bsArg = 128;
        if (nIn   <= 0) nIn   = 2;
        auto err = engine.setAudioDevice(inName, outName, srArg, bsArg, nIn);
        if (err.isNotEmpty()) { errorOut = err; return {}; }

        auto* o = new juce::DynamicObject();
        o->setProperty("sampleRate", engine.getCurrentSampleRate());
        o->setProperty("bufferSize", engine.getCurrentBufferSize());
        o->setProperty("numActiveInputs", engine.getNumActiveInputs());
        o->setProperty("numActiveOutputs", engine.getNumActiveOutputs());
        o->setProperty("inputLatencySamples", engine.getInputLatencySamples());
        o->setProperty("outputLatencySamples", engine.getOutputLatencySamples());
        return juce::var(o);
    }
    if (cmd == "addTrack")
    {
        auto err = engine.addTrack(args["id"].toString(),
                                   args["name"].toString(),
                                   (int) args["inputCh"],
                                   (int) args["outL"],
                                   (int) args["outR"]);
        if (err.isNotEmpty()) { errorOut = err; return {}; }
        return juce::var(true);
    }
    if (cmd == "removeTrack")     { engine.removeTrack(args["id"].toString()); return juce::var(true); }
    if (cmd == "setTrackInput")   { engine.setTrackInput(args["id"].toString(), (int) args["inputCh"]); return juce::var(true); }
    if (cmd == "setTrackOutput")  { engine.setTrackOutput(args["id"].toString(), (int) args["outL"], (int) args["outR"]); return juce::var(true); }
    if (cmd == "setTrackBus")     { engine.setTrackBus(args["id"].toString(), args["busId"].toString()); return juce::var(true); }
    if (cmd == "setTrackDest")    { engine.setTrackDest(args["id"].toString(), args["dest"].toString()); return juce::var(true); }
    if (cmd == "setTrackInputMode")  { engine.setTrackInputMode(args["id"].toString(),  args["mode"].toString()); return juce::var(true); }
    if (cmd == "setTrackOutputMode") { engine.setTrackOutputMode(args["id"].toString(), args["mode"].toString()); return juce::var(true); }
    if (cmd == "setTrackGain")    { engine.setTrackGainDb(args["id"].toString(), (float) (double) args["gainDb"]); return juce::var(true); }
    if (cmd == "setTrackPan")     { engine.setTrackPan(args["id"].toString(), (float) (double) args["pan"]); return juce::var(true); }
    if (cmd == "setTrackMute")    { engine.setTrackMute(args["id"].toString(), (bool) args["mute"]); return juce::var(true); }
    if (cmd == "setTrackMonitor") { engine.setTrackMonitor(args["id"].toString(), (bool) args["monitor"]); return juce::var(true); }
    if (cmd == "setTrackSolo")    { engine.setTrackSolo(args["id"].toString(), (bool) args["solo"]); return juce::var(true); }

    if (cmd == "addBus")
    {
        auto err = engine.addBus(args["id"].toString(), args["name"].toString(),
                                 (int) args["outL"], (int) args["outR"]);
        if (err.isNotEmpty()) { errorOut = err; return {}; }
        return juce::var(true);
    }
    if (cmd == "removeBus")    { engine.removeBus(args["id"].toString()); return juce::var(true); }
    if (cmd == "setBusOutput") { engine.setBusOutput(args["id"].toString(), (int) args["outL"], (int) args["outR"]); return juce::var(true); }
    if (cmd == "setBusDest")   { engine.setBusDest(args["id"].toString(), args["dest"].toString()); return juce::var(true); }
    if (cmd == "setBusOutputMode") { engine.setBusOutputMode(args["id"].toString(), args["mode"].toString()); return juce::var(true); }
    if (cmd == "setBusGain")   { engine.setBusGainDb(args["id"].toString(), (float) (double) args["gainDb"]); return juce::var(true); }
    if (cmd == "setBusPan")    { engine.setBusPan(args["id"].toString(), (float) (double) args["pan"]); return juce::var(true); }
    if (cmd == "setBusMute")   { engine.setBusMute(args["id"].toString(), (bool) args["mute"]); return juce::var(true); }

    if (cmd == "loadPluginOnBus")
    {
        auto err = engine.loadPluginOnBus(args["id"].toString(), (int) args["slot"],
                                          args["pluginId"].toString(), args["state"].toString());
        if (err.isNotEmpty()) { errorOut = err; return {}; }
        return juce::var(true);
    }
    if (cmd == "removePluginOnBus")
    {
        engine.clearPluginOnBus(args["id"].toString(), (int) args["slot"]);
        return juce::var(true);
    }
    if (cmd == "setBusPluginBypassed")
    {
        engine.setPluginBypassedOnBus(args["id"].toString(), (int) args["slot"], (bool) args["bypassed"]);
        return juce::var(true);
    }
    if (cmd == "reorderPluginOnBus")
    {
        engine.reorderPluginOnBus(args["id"].toString(), (int) args["fromSlot"], (int) args["toSlot"]);
        return juce::var(true);
    }
    if (cmd == "showBusPluginEditor")
    {
        bool ok = engine.showBusPluginEditor(args["id"].toString(), (int) args["slot"]);
        return juce::var(ok);
    }
    if (cmd == "hideBusPluginEditor")
    {
        engine.hideBusPluginEditor(args["id"].toString(), (int) args["slot"]);
        return juce::var(true);
    }
    if (cmd == "getBusPluginState")
    {
        return juce::var(engine.getBusPluginState(args["id"].toString(), (int) args["slot"]));
    }

    if (cmd == "scanPlugins")
    {
        int n = engine.plugins().scan([this](int current, int total, const juce::String& name) {
            auto* o = new juce::DynamicObject();
            o->setProperty("current", current);
            o->setProperty("total", total);
            o->setProperty("name", name);
            emitEvent("scanProgress", juce::var(o));
        });
        auto* o = new juce::DynamicObject();
        o->setProperty("count", n);
        o->setProperty("plugins", pluginListToVar(engine.plugins().getKnownList()));
        return juce::var(o);
    }
    if (cmd == "listPlugins")
    {
        return pluginListToVar(engine.plugins().getKnownList());
    }
    if (cmd == "loadPlugin")
    {
        auto err = engine.loadPluginOnTrack(args["id"].toString(), (int) args["slot"],
                                            args["pluginId"].toString(),
                                            args["state"].toString());
        if (err.isNotEmpty()) { errorOut = err; return {}; }
        return juce::var(true);
    }
    if (cmd == "getPluginState")
    {
        return juce::var(engine.getPluginState(args["id"].toString(), (int) args["slot"]));
    }
    if (cmd == "removePlugin")
    {
        engine.clearPluginOnTrack(args["id"].toString(), (int) args["slot"]);
        return juce::var(true);
    }
    if (cmd == "setPluginBypassed")
    {
        engine.setPluginBypassedOnTrack(args["id"].toString(), (int) args["slot"], (bool) args["bypassed"]);
        return juce::var(true);
    }
    if (cmd == "reorderPlugin")
    {
        engine.reorderPluginOnTrack(args["id"].toString(), (int) args["fromSlot"], (int) args["toSlot"]);
        return juce::var(true);
    }
    if (cmd == "showPluginEditor")
    {
        bool ok = engine.showPluginEditor(args["id"].toString(), (int) args["slot"]);
        return juce::var(ok);
    }
    if (cmd == "hidePluginEditor")
    {
        engine.hidePluginEditor(args["id"].toString(), (int) args["slot"]);
        return juce::var(true);
    }
    if (cmd == "getEngineState")
    {
        return engine.captureState();
    }
    if (cmd == "applyEngineState")
    {
        auto err = engine.applyState(args);
        if (err.isNotEmpty()) { errorOut = err; return {}; }
        return juce::var(true);
    }

    errorOut = "Unknown command: " + cmd;
    return {};
}

void IpcServer::timerCallback()
{
    auto meters = engine.snapshotMeters();
    juce::Array<juce::var> arr;
    for (auto& m : meters)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty("id", m.id);
        o->setProperty("in", m.in);
        o->setProperty("outL", m.outL);
        o->setProperty("outR", m.outR);
        o->setProperty("monitoring", m.monitoring);
        arr.add(juce::var(o));
    }
    auto busMeters = engine.snapshotBusMeters();
    juce::Array<juce::var> busArr;
    for (auto& m : busMeters)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty("id", m.id);
        o->setProperty("inL", m.inL);
        o->setProperty("inR", m.inR);
        o->setProperty("outL", m.outL);
        o->setProperty("outR", m.outR);
        busArr.add(juce::var(o));
    }
    auto* root = new juce::DynamicObject();
    root->setProperty("tracks", arr);
    root->setProperty("buses",  busArr);
    // Latency reported on every tick so the UI updates immediately when plugins
    // are added/removed/bypassed — no separate event needed.
    root->setProperty("roundTripLatencySamples", engine.getRoundTripLatencySamples());
    root->setProperty("sampleRate", engine.getCurrentSampleRate());
    emitEvent("meters", juce::var(root));
}
