"use client";

import { useEffect, useState, type ReactNode } from "react";

export function StandaloneOnly({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const [embedded, setEmbedded] = useState(true);
  useEffect(() => setEmbedded(window.parent !== window), []);
  return embedded ? null : children;
}
