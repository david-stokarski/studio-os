#include "PluginHost.h"

PluginHost::PluginHost()
{
    formatManager.addDefaultFormats();
}

juce::File PluginHost::getCacheFile()
{
    auto dir = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                   .getChildFile("AudioInterface");
    if (! dir.exists()) dir.createDirectory();
    return dir.getChildFile("plugins.xml");
}

bool PluginHost::loadCache()
{
    auto f = getCacheFile();
    if (! f.existsAsFile()) return false;
    auto xml = juce::XmlDocument::parse(f);
    if (! xml) return false;
    knownList.recreateFromXml(*xml);
    return knownList.getNumTypes() > 0;
}

bool PluginHost::saveCache()
{
    auto xml = knownList.createXml();
    if (! xml) return false;
    return xml->writeTo(getCacheFile());
}

int PluginHost::scan(ProgressCallback onProgress, int /*numThreads*/)
{
    // AudioUnit instantiation/validation must happen on the main (message)
    // thread on macOS — many AUs call into AppKit/CoreFoundation runloops
    // during construction. Multi-threading this caused indefinite hangs.
    // We keep the scan serial; the disk cache means it only runs once.
    knownList.clear();

    for (auto* format : formatManager.getFormats())
    {
        if (format->getName() != "AudioUnit")
            continue;

        auto paths = format->getDefaultLocationsToSearch();
        auto identifiers = format->searchPathsForPlugins(paths, /*recursive*/ true, /*allowAsync*/ false);
        const int total = identifiers.size();
        if (total == 0) continue;

        for (int i = 0; i < total; ++i)
        {
            const auto& id = identifiers[i];

            if (onProgress) onProgress(i, total, id);

            juce::OwnedArray<juce::PluginDescription> found;
            try { format->findAllTypesForFile(found, id); }
            catch (...) { /* some AUs throw on validation; skip them */ }

            for (auto* d : found)
                knownList.addType(*d);
        }

        if (onProgress) onProgress(total, total, juce::String());
    }

    saveCache();
    return knownList.getNumTypes();
}

std::unique_ptr<juce::AudioPluginInstance> PluginHost::createInstance(const juce::String& identifierString,
                                                                     double sampleRate, int blockSize,
                                                                     juce::String& errorMessage)
{
    auto desc = knownList.getTypeForIdentifierString(identifierString);
    if (! desc)
    {
        errorMessage = "Plugin not found: " + identifierString;
        return nullptr;
    }

    // Guard against C++ exceptions thrown during AU instantiation. JUCE itself
    // doesn't throw, but the plugin's own constructor (especially licensed AUs
    // like SSL 360 or Slate Digital) can throw on missing daemons / activation
    // failures. We can't catch a SIGSEGV from misbehaving native code — that
    // still kills the engine — but at least the recoverable failures end up
    // here as a clean error rather than taking the process down.
    try
    {
        auto inst = formatManager.createPluginInstance(*desc, sampleRate, blockSize, errorMessage);
        if (! inst && errorMessage.isEmpty())
            errorMessage = "Plugin returned null instance";
        return inst;
    }
    catch (const std::exception& e)
    {
        errorMessage = juce::String("Plugin threw during instantiation: ") + e.what();
        return nullptr;
    }
    catch (...)
    {
        errorMessage = "Plugin threw an unknown exception during instantiation";
        return nullptr;
    }
}
