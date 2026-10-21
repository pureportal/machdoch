import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const root = "D:/Models/machdoch/verification/2026-10-13/image-engines";
const judgments = {
  "flux-1-schnell": {
    144655944: ["below-reference", "Clean detailed anime face and warm doorway light; foreground hand anatomy and ownership are unclear, with weaker painted texture."],
    144697438: ["near-reference", "Detailed painted woman in right profile, two rusty robots, ruins and concentric colored sky; lighter palette and cleaner texture than source."],
    144594528: ["near-reference", "Detailed photographic subject, windblown hair and white skirt, blue blouse, sneakers and colorful wall; pose and wall motifs differ."],
    145095967: ["below-reference", "Detailed raised-arm photographic subject and Alpine landscape; mountains appear printed on an opaque shirt rather than through a transparent torso."],
    144599398: ["below-reference", "Detailed patterned pink swimwear and warm stone-wall setting; smooth rendered skin and generated footer text weaken the photographic treatment."],
    145177887: ["near-reference", "Detailed frilled dress, concealed face, teddy, dark room and watching eyes create a similar uncanny aesthetic; warmer floor light and teddy position differ."],
  },
  "flux-2": {
    144655944: ["below-reference", "Detailed anime face, doorway and warm light, but two overlapping hands create an anatomical defect and the painted atmosphere is weaker."],
    144697438: ["near-reference", "White-bob blindfolded woman on the right, two rusty robots left, ruined city and concentric colored sky; cleaner graphic texture than the source painting."],
    144599398: ["near-reference", "Detailed photographic subject and patterned pink swimsuit against warm stone and white wall; pose, framing and wall texture differ."],
  },
  "pony": {
    144655944: ["below-reference", "Smooth anime face and shirt/tie, but raised arms replace the reaching hand; weak painted lighting and texture."],
    144697438: ["below-reference", "Muted ruin landscape only; woman and two robots are absent."],
    144594528: ["below-reference", "Colorful illustration with white skirt and sneakers, but the photographic subject, blouse and street wall are missing."],
    145095967: ["below-reference", "Painted subject and mountain path, but no transparent torso, blouse outlines or frontal double exposure."],
    144599398: ["below-reference", "Soft illustrated swimsuit figure; weak skin detail, different pose and setting, absent chevron pattern."],
    145177887: ["below-reference", "Clean adult anime dress portrait on gray background; teddy, child subject and black-room atmosphere are absent."],
  },
  "krea-2-turbo-accepted-regression": {
    144594528: ["near-reference", "Detailed smiling photographic subject, blue off-shoulder blouse, flowing white skirt, wind and vivid flower-painted wall; pose and framing differ."],
  },
  "qwen-image-2.1-turbo-accepted-regression": {
    144655944: ["near-reference", "Detailed painterly red-haired subject, amber eyes, shirt/tie, golden doorway light and foreshortened reaching hand; exact pose and texture differ."],
  },
  "stable-diffusion-xl": {
    144655944: ["below-reference", "Recognizable anime shirt-and-tie subject and doorway, but weaker painted detail, hand perspective and dramatic light."],
    144697438: ["below-reference", "Muted robot-themed painting, but intended woman, two small robots and circular glitch composition are absent."],
    144594528: ["near-reference", "Detailed photographic subject, white skirt, sneakers and colorful wall; pose is static and blouse/flower motifs differ."],
    145095967: ["below-reference", "Raised-arm woman and Alpine scene, but opaque back-view subject replaces transparent frontal collage."],
    144599398: ["below-reference", "Plausible warm photo and pink swimwear, but distant small subject and smooth wall lose the reference's close skin detail and framing."],
    145177887: ["below-reference", "Detailed dress/floor painting and teddy, but bright room and sideways subject miss the near-black photographic atmosphere."],
  },
  "stable-diffusion-1": {
    144655944: ["below-reference", "Simple anime face with red hair and amber eyes; shirt/tie, reaching hand, doorway and painterly light largely missing."],
    144697438: ["below-reference", "Abstract geometric composition replaces the requested woman, robots and textured ruins."],
    144594528: ["below-reference", "Photographic street/wall motif, but rear-view subject, black blouse and static pose differ; limited fine detail."],
    145095967: ["below-reference", "Disembodied upside-down face/arm and mountains; composition and anatomy fail the requested collage."],
    144599398: ["below-reference", "Woman and pink swimwear are present; distorted crouching anatomy, weak detail and different scene."],
    145177887: ["below-reference", "Two old-fashioned portrait figures replace the single dark-room child holding a teddy."],
  },
  "illustrious-xl-tag-refinement": {
    144655944: ["below-reference", "Improved single reaching-hand composition and rich backlit clothing; still weaker hand anatomy, texture and atmosphere than the reference."],
    144697438: ["below-reference", "Detailed dress and ruined towers, but robots and circular/glitch motif remain absent."],
    145095967: ["below-reference", "Pleasing sunset illustration, but face is blank and the landscape-through-torso effect is absent."],
    144594528: ["below-reference", "Clean anime subject and sneakers, but muted clothing and a flower hedge replace the photograph's flowing skirt and painted wall."],
    144599398: ["below-reference", "Seated illustrated swimsuit subject on stone steps; distant framing, different pattern and smooth texture miss the photographic aesthetic."],
    145177887: ["below-reference", "Chibi dress-and-teddy illustration on a dark floor; simplified proportions and visible face differ from the detailed uncanny reference."],
  },
  "noobai-xl-tag-refinement": {
    144655944: ["below-reference", "Improved amber eyes and perspective, but foreground hands are blurred and the image lacks the reference's detailed painted depth."],
    144697438: ["below-reference", "Woman and a large robot shape appear, but two small robots, ruined-city detail and circular motif remain missing."],
    145095967: ["below-reference", "Detailed anime subject and pink landscape, but opaque blouse, missing torso collage and different pose."],
    144594528: ["below-reference", "Detailed windblown anime portrait and blue blouse; close crop and illustrated texture lose the photographic motion and flower-painted wall."],
    144599398: ["below-reference", "Clean seated anime figure on stone steps; blue swimsuit and smooth skin lack the patterned pink photographic treatment."],
    145177887: ["below-reference", "Improved dark background, concealed face, white clothing and held teddy; plain dress and strong floor spotlight lose the reference's fine frills and faint light."],
  },
  "sd-turbo": {
    144655944: ["below-reference", "Recognizable red-haired shirt-and-tie portrait, but weak hand perspective and coarse illustrated texture."],
    144697438: ["below-reference", "Several robots are present, but the woman is missing and pixel-like painted texture lacks the source detail and composition."],
    144594528: ["below-reference", "Graffiti, skirt and motion are present, but subject faces away; coarse texture, wrong clothing and no floral motifs."],
    145095967: ["below-reference", "Woman, jeans and mountains are present, but no transparent torso or fine outlines; detail is coarse."],
    144599398: ["below-reference", "Pink patterned swimwear and stone steps, but frontal pose, coarse skin detail and pattern differ."],
    145177887: ["below-reference", "White dress and teddy are present, but the seated illustrated portrait lacks the black-room photographic atmosphere."],
  },
  "sdxl-turbo": {
    144655944: ["below-reference", "Clean anime face and reaching-hand motif, but weaker painterly depth, lighting and anatomical detail than source."],
    144697438: ["below-reference", "Pleasing muted painting with robots and ruined city; woman and concentric glitch motif are absent."],
    144594528: ["near-reference", "Convincing smiling photographic subject, blue off-shoulder blouse and colorful graffiti; skirt pattern, pose and framing differ."],
    145095967: ["below-reference", "Pleasing Alpine photograph, but back-view subject and opaque blouse replace the transparent frontal collage."],
    144599398: ["near-reference", "Natural photographic face/skin, pink chevron swimsuit and warm weathered stone wall; crop, seated pose and gaze differ."],
    145177887: ["below-reference", "Detailed painted dress and floorboards, but teddy is absent and the side-view figure in a bright room misses the photographic horror atmosphere."],
  },
  "anima": {
    144655944: ["near-reference", "Strong golden backlight, detailed fabric/hair, amber eyes and a clearly foreshortened reaching hand; color is more yellow than the source."],
    144697438: ["near-reference", "Two rusty robots on the left, white-haired blindfolded woman on the right, textured ruins and concentric colored/glitch sky. Rendering is more graphic than the source painting."],
    144594528: ["near-reference", "Detailed smiling subject, blue blouse, flowing white skirt, moving hair and colorful street wall; face has a slightly rendered appearance."],
    145095967: ["below-reference", "Clear landscape-through-torso effect and fine blouse outlines, but subject becomes a faceless back-view silhouette on a plain background."],
    144599398: ["near-reference", "Detailed skin and patterned pink swimsuit, side pose and warm stone-wall photo. Orange cast, vertical black borders and framing differ."],
    145177887: ["below-reference", "Dark room, white dress, teddy and illuminated floor are present, but figure is too small and extra eyes appear above it; less photographic detail than source."],
  },
  "realvis-xl": {
    144655944: ["below-reference", "Photographic face, shirt and doorway, but the painterly anime style and dramatic reaching hand are absent."],
    144697438: ["below-reference", "Detailed ruined buildings, but the woman becomes a helmeted robot and the composition is dominated by three mismatched figures."],
    144594528: ["near-reference", "Convincing photographic subject, cheerful expression, moving hair/skirt and colorful street wall; clothing colors and wall motifs differ."],
    145095967: ["below-reference", "Detailed mountain photo and raised-arm pose, but no double exposure, transparent torso or outline blouse."],
    144599398: ["near-reference", "Natural photographed skin, pink zigzag swimsuit, warm sun and stone steps; pose and wall framing differ."],
    145177887: ["below-reference", "Detailed photographic dress and floorboards; teddy is on the head and the bright room misses the black-background horror lighting."],
  },
  "dreamshaper-xl": {
    144655944: ["below-reference", "Detailed painted clothing and warm light; weak foreshortening, atmosphere and hand anatomy."],
    144697438: ["below-reference", "Painted texture and a white-haired woman; both robots and circular glitch composition are missing."],
    144594528: ["near-reference", "Credible photographic face, clothing, street and colorful wall. Pose is more static and the flower motifs are absent."],
    145095967: ["below-reference", "Pleasing Alpine photo, but there is no transparent torso or white blouse outline; arms are lowered."],
    144599398: ["near-reference", "Photographic skin, warm sun, pink patterned swimsuit and stone steps. Frontal pose and smooth wall differ from the source."],
    145177887: ["below-reference", "Dark painted figure and detailed dress; teddy bear is missing and the bright corridor differs from the near-black photograph."],
  },
  "illustrious-xl": {
    144655944: ["below-reference", "Strong golden doorway light, hair and cloth texture, but arms merge into one malformed foreground hand."],
    144697438: ["below-reference", "Oil texture and ruined buildings, but no robots or concentric glitch circles; subject is frontal."],
    144594528: ["below-reference", "Bold colorful illustration, but the reference is a detailed photograph and the wall design and pose differ."],
    145095967: ["below-reference", "Two flat faceless figures replace the single photographic double exposure; transparent torso is absent."],
    144599398: ["below-reference", "Smooth rendered skin and swimsuit; large foreground stone occludes the body and face is turned away."],
    145177887: ["below-reference", "Clean doll-like illustration with dress and teddy, but the room is light gray and photographic horror atmosphere is absent."],
  },
  "noobai-xl": {
    144655944: ["below-reference", "Good hair, clothing and backlight, with cropped foreground hands; less dramatic depth and dark atmosphere than the reference."],
    144697438: ["below-reference", "Very simplified painted figure; robots, circles, detail and intended composition are missing."],
    144594528: ["below-reference", "Competent illustration, but wrong clothing colors and no colorful wall; photographic motion and realism are absent."],
    145095967: ["below-reference", "Pleasing anime landscape and profile, but no landscape-through-torso effect or fine white contour drawing."],
    144599398: ["below-reference", "Smooth illustrated skin and stone stairs; lower body is occluded, pose differs and photographic texture is weak."],
    145177887: ["below-reference", "Dress and teddy are present, but flat anime treatment and a bright spotlight replace the photographic black-room atmosphere."],
  },
};
const reviewed = [];
for (const [engine, cases] of Object.entries(judgments)) {
  const results = JSON.parse(await readFile(`${root}/${engine}/results.json`, "utf8"));
  for (const [reference, [verdict, observation]] of Object.entries(cases)) {
    const result = results.models.findLast(model => model.passed && model.referenceId === Number(reference));
    if (!result) throw new Error(`No completed render: ${engine}/${reference}`);
    const digest = createHash("sha256").update(await readFile(result.image)).digest("hex");
    if (digest !== result.sha256) throw new Error(`Render changed: ${result.image}`);
    reviewed.push({ engine: result.architecture, batch: engine, referenceId: Number(reference), image: result.image, sha256: digest, verdict, observation, method: "Direct visual inspection against the downloaded reference; qualitative judgment, not an objective quality score." });
  }
}
await writeFile("docs/validation/image-engines/research-2026-10-13/first-visual-review.json", JSON.stringify({ reviewedAt: new Date().toISOString(), reviewed, fullGoalComplete: false }, null, 2));
console.log(JSON.stringify({ inspected: reviewed.length, nearReference: reviewed.filter(r => r.verdict === "near-reference").length }));
