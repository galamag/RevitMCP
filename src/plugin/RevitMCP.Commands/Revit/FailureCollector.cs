using Autodesk.Revit.DB;

namespace RevitMCP.Commands;

/// <summary>
/// Takes over the failures of one transaction, so that none reaches the user: warnings are recorded and deleted, and
/// any failure worse than a warning is recorded and rolls the transaction back.
/// </summary>
public sealed class FailureCollector : IFailuresPreprocessor
{
    private readonly List<string> _warnings = [];
    private readonly List<string> _errors = [];

    public IReadOnlyList<string> Warnings => _warnings;

    public IReadOnlyList<string> Errors => _errors;

    public FailureProcessingResult PreprocessFailures(FailuresAccessor failuresAccessor)
    {
        foreach (var failure in failuresAccessor.GetFailureMessages())
        {
            if (failure.GetSeverity() == FailureSeverity.Warning)
            {
                _warnings.Add(failure.GetDescriptionText());
                failuresAccessor.DeleteWarning(failure);
            }
            else
            {
                _errors.Add(failure.GetDescriptionText());
            }
        }

        return _errors.Count > 0 ? FailureProcessingResult.ProceedWithRollBack : FailureProcessingResult.Continue;
    }
}
