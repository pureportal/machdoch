export const MEDIA_PARAMETER_DESCRIPTIONS = {
  quality:
    "Trades speed for detail. Draft is fastest; High takes longer and gives cleaner results.",
  sampler:
    "The algorithm that removes noise step by step. Automatic picks the best match for the model.",
  resolution:
    "Pixel size of the result. Higher sizes show more detail but need more memory and time.",
  width: "Output width in pixels.",
  height: "Output height in pixels.",
  numInferenceSteps:
    "Denoising passes. More steps refine detail but take longer; past the green range the gain is small.",
  guidanceScale:
    "How strictly the result follows the prompt. Higher values follow it more literally but can look harsh or oversaturated.",
  seed: "Fixes the random start so the same settings reproduce the same result. Random gives a new result each time.",
  memoryProfile:
    "Memory saver fits larger models on smaller GPUs at the cost of speed. Automatic chooses for this device.",
  canvasSize: "Pixel size the vector artwork is designed for.",
  candidates: "Drafts generated before the best one is kept. More candidates improve the odds of a good result but take longer.",
  outputCount: "Number of results generated in one run.",
  svgTextPolicy: "Whether the artwork may contain lettering.",
  aspectRatio: "Shape of the result.",
  outputSize: "Pixel size of the edited result.",
  format: "File type of the saved result.",
  fps: "Frames shown per second. Higher rates look smoother but need more frames for the same length.",
  numFrames: "Length of the clip in frames. More frames make a longer clip and take longer to generate.",
  encoding: "How the video file is compressed.",
  motionGuidance:
    "How strictly motion follows the prompt and reference. Higher values follow it more literally but can look stiff.",
} as const;
