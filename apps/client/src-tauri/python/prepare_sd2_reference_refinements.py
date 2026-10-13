import argparse
import json
from pathlib import Path


PROMPTS = {
    144655944: "Anime illustration with detailed cel shading. A red-haired young adult woman extends one open hand toward the camera, palm large in the foreground. Amber eyes, white long-sleeved shirt and dark necktie. Dramatic foreshortening, dark doorway, brilliant warm backlighting, confident expression, clean linework.",
    144697438: "Wide oil painting. A blindfolded woman with a white bob haircut and ornate black dress fills the right foreground, full body visible. A collapsed round rusty robot lies at the left. Ruined stone towers and green vegetation, colorful spiral patterns in the sky, rich layered brushwork, pencil lines and rough canvas.",
    144594528: "Natural candid film photograph. An adult woman leans forward beside a colorful flower mural, smiling softly with her mouth closed. Blue off-shoulder blouse, flowing white midi skirt and white sneakers. Long black hair, warm afternoon sunlight, realistic skin, shallow depth of field, wind lifting the skirt.",
    145095967: "Surreal photographic double exposure. A dark-haired adult woman raises her arms above her head and looks downward. Her buttoned blouse is only a fine white outline; a realistic mountain valley and narrow road remain visible through her transparent torso. Photographic skin and hair, pink sunset sky, dark alpine cliffs, muted cinematic colors.",
    144599398: "Natural film photograph of an adult woman in a coral and white zigzag two-piece bikini, seated against a pale limestone wall. One bent knee crosses the foreground, her arms support her seated pose, dark hair loosely tied back. Warm afternoon sunlight, realistic skin texture, soft film grain, gentle contrast.",
    145177887: "Dark oil painting of a small fully clothed child standing alone on a wooden floor. Pale long-sleeved knee-length nightdress, white socks, black Mary Jane shoes. Long dark hair completely hides the face. A worn teddy bear hangs from one hand. Almost black room, only two faint distant eyes behind the child, narrow overhead light, rough canvas.",
}


def prepare(root: Path) -> None:
    cases = json.loads((root / "stable-diffusion-2-six-reference-cases.json").read_text(encoding="utf-8"))
    for case in cases:
        reference = case["id"]
        prompt = root / f"prompt-{reference}-sd2-refined.txt"
        negative = root / f"negative-{reference}-sd2-refined.txt"
        prompt.open("x", encoding="utf-8").write(PROMPTS[reference] + "\n")
        exclusions = "extra fingers, malformed hands, duplicate people, distorted face, text, watermark"
        if reference in (144594528, 144599398):
            exclusions += ", painting, illustration, plastic skin, harsh contrast, oversharpened edges"
        elif reference == 145095967:
            exclusions += ", graphic poster, flat cartoon, opaque blouse, rectangular image border"
        elif reference == 145177887:
            exclusions += ", visible face, smiling, bright room, close-up portrait, seated pose"
        negative.open("x", encoding="utf-8").write(exclusions + "\n")
        case.update(promptFile=str(prompt), negativePromptFile=str(negative), originalPrompt=False,
                    adaptationPurpose="Subject and style refinement after the inspected SD 2.1 baseline")
        case["sampling"].update(numInferenceSteps=40, guidanceScale=6 if reference in (144594528, 144599398) else 7.5)
    output = root / "stable-diffusion-2-refined-six-reference-cases.json"
    output.open("x", encoding="utf-8").write(json.dumps(cases, indent=2))
    print(json.dumps({"cases": str(output), "count": len(cases)}), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    prepare(parser.parse_args().root)


if __name__ == "__main__":
    main()
