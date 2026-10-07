import type { JSX } from "react";
import { studentModelSetup } from "../../../../core/media/student-model-setup.js";
import { MediaExternalLink } from "./media-external-link";

export const MediaStudentSetup = ({
  architecture,
}: {
  architecture: string;
}): JSX.Element | null => {
  const setup = studentModelSetup(architecture);
  if (!setup) return null;
  const linkClass = "text-sky-300 underline";
  return (
    <div className="space-y-3 text-sm text-slate-300">
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          Get the{" "}
          <MediaExternalLink href={setup.baseUrl} className={linkClass}>
            {setup.isH3 ? "full MiniMax H3 base" : "SDXL base 1.0"}
          </MediaExternalLink>
          {setup.isH3 ? " with its original text encoder." : " components."}
        </li>
        <li>
          <MediaExternalLink href={setup.checkpointUrl} className={linkClass}>
            Download student
          </MediaExternalLink>{" "}
          and save it in the base folder as{" "}
          <code className="break-all text-xs">
            {setup.profile.distillation!.checkpointFile}
          </code>
          .
        </li>
        <li>Select that model folder below.</li>
      </ol>
      <details className="text-xs">
        <summary className="cursor-pointer">Folder contents</summary>
        <ul className="mt-2 space-y-1 font-mono">
          {setup.requiredPaths.map((path) => (
            <li key={path} className="break-all">
              {path}
            </li>
          ))}
        </ul>
      </details>
      {setup.isH3 ? (
        <>
          <p className="text-xs">
            CUDA or ROCm required.{" "}
            {setup.profile.distillation!.method === "pdmd"
              ? "Publisher test setup: 24 GB VRAM and 128 GB RAM. "
              : null}
            <MediaExternalLink
              href={
                setup.profile.distillation!.method === "pdmd"
                  ? "https://github.com/ZeamoxWang/pdmd#inference"
                  : "https://github.com/Yzmblog/DMAD#on-consumer-gpus"
              }
              className={linkClass}
            >
              Hardware setup
            </MediaExternalLink>
          </p>
          <p className="text-xs">
            The H3 licence excludes the EU, UK, US and South Korea; use there
            needs a separate grant.{" "}
            <MediaExternalLink
              href={setup.profile.license.sourceUrl!}
              className={linkClass}
            >
              H3 licence
            </MediaExternalLink>
          </p>
        </>
      ) : null}
    </div>
  );
};
