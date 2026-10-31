using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitMCP.Plugin.Dispatch;

/// <summary>What a command gets to work with. <see cref="Document"/> is the active document, if any.</summary>
public sealed record CommandContext(UIApplication UiApp, Document? Document);

/// <summary>One bridge method served on the Revit main thread.</summary>
public interface ICommand
{
    /// <summary>The method name, as listed in <c>MethodNames</c>.</summary>
    string Method { get; }

    /// <summary>When true, the request fails with <c>no_active_document</c> without reaching the command.</summary>
    bool NeedsDocument { get; }

    /// <summary>
    /// Runs the command. The result outlives this call, so it must not depend on a <see cref="JsonDocument"/>
    /// that gets disposed: build it with <see cref="JsonSerializer.SerializeToElement{TValue}(TValue, JsonSerializerOptions?)"/>.
    /// </summary>
    JsonElement Execute(CommandContext context, JsonElement parameters);
}
