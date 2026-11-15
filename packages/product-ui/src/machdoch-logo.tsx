import { useId, type SVGProps } from "react";

export function MachdochLogo(props: SVGProps<SVGSVGElement>) {
  const gradientId = `machdoch-logo-${useId().replace(/[^\w-]/g, "")}`;

  return (
    <svg viewBox="44 40 432 432" fill="none" aria-hidden="true" {...props}>
      <defs>
        <linearGradient
          id={gradientId}
          x1="0"
          y1="64"
          x2="0"
          y2="448"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#3AD4EA" />
          <stop offset="1" stopColor="#1A78E0" />
        </linearGradient>
      </defs>
      <g strokeLinecap="round" strokeLinejoin="round">
        <path d="M96 152l116 104-116 104" stroke="#3AD4EA" strokeWidth="64" />
        <path
          d="M248 112l160 144-160 144"
          stroke={`url(#${gradientId})`}
          strokeWidth="96"
        />
      </g>
    </svg>
  );
}
