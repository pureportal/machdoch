from datetime import datetime, timezone
import json
from pathlib import Path


root = Path(__file__).parent
audit = json.loads((root / "audit/engine-coverage-audit-current.json").read_text(encoding="utf-8"))
destination = root / "requested-engine-coverage.json"
matrix = json.loads(destination.read_text(encoding="utf-8"))
required = set(audit["requiredReferences"])
for row in matrix["matrix"]:
    coverage = [item for item in audit["coverage"] if item["architecture"] in row["architectures"]]
    technical = set().union(*(set(item["referencesWithTechnicalPass"]) for item in coverage))
    near = set().union(*(set(item["referencesWithNearReferenceAesthetic"]) for item in coverage))
    installed = {model["id"]: model for item in coverage for model in item["installedModels"]}
    tested = {
        installed[run["id"]]["name"]
        for item in coverage for run in item["realRuns"]
        if run["validEvidence"] and run["id"] in installed
    }
    row.update(
        samplingProfiles=[{
            "architecture": item["architecture"],
            "samplers": item["samplers"],
            "sources": item["settingsSources"],
        } for item in coverage],
        installedModels=list(installed.values()), testedModels=sorted(tested),
        technicalReferences=sorted(technical), nearReferenceAssessments=sorted(near),
        remainingTechnicalReferences=sorted(required - technical),
        remainingReferenceAssessments=sorted(required - near),
        allSixTechnicalVerified=required <= technical,
        allSixReferenceQualityVerified=required <= near,
    )
matrix.update(
    checkedAt=datetime.now(timezone.utc).isoformat(),
    nativeValidationRecords=audit["nativeValidationRecords"],
    enginesWithAllSixTechnicalPasses=sum(row["allSixTechnicalVerified"] for row in matrix["matrix"]),
    enginesWithAllSixNearReferenceAssessments=sum(row["allSixReferenceQualityVerified"] for row in matrix["matrix"]),
    allSamplingProfilesQualityVerified=all(item["allSixReferenceQualityVerified"] for item in audit["coverage"]),
)
matrix["fullGoalComplete"] = (
    audit["overallComplete"] and matrix["allSamplingProfilesQualityVerified"]
    and all(row["allSixReferenceQualityVerified"] for row in matrix["matrix"])
)
destination.write_text(json.dumps(matrix, indent=2), encoding="utf-8")
print(json.dumps({key: matrix[key] for key in (
    "nativeValidationRecords", "enginesWithAllSixTechnicalPasses",
    "enginesWithAllSixNearReferenceAssessments", "fullGoalComplete",
)}))
