"use client";

import {
  CircleDot,
  FolderKanban,
  Inbox,
  Moon,
  RefreshCcw,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { brandPalette, brandShapeRadius } from "@/lib/brand-palette";
import { BrandSegmented } from "./brand-controls";
import { BrandMark, type BrandIdentity } from "./brand-mark";

type PreviewTheme = "dark" | "light";
type PreviewView = "workspace" | "sign-in";

const navigation = [
  { label: "Inbox", icon: Inbox },
  { label: "Issues", icon: CircleDot },
  { label: "Projects", icon: FolderKanban },
  { label: "Cycles", icon: RefreshCcw },
];

export function BrandPreview({ identity }: { identity: BrandIdentity }) {
  const [theme, setTheme] = useState<PreviewTheme>("dark");
  const [requestedView, setView] = useState<PreviewView>("workspace");
  useEffect(() => {
    if (document.documentElement.dataset.theme === "light") setTheme("light");
  }, []);
  const view = identity.brand.signIn ? requestedView : "workspace";
  const colors = brandPalette(identity.brand)[theme];
  const fill = colors.gradient
    ? `linear-gradient(135deg, ${colors.primary}, ${colors.gradient})`
    : colors.primary;
  const style = {
    "--primary": colors.primary,
    "--primary-foreground": colors.foreground,
    "--cloud-brand-fill": fill,
    "--cloud-brand-radius": brandShapeRadius[identity.brand.shape],
  } as CSSProperties;
  const name = identity.name.trim() || "Organization";
  const mark = <BrandMark identity={{ ...identity, name }} colors={colors} />;
  return (
    <aside className="cloud-brand-preview" aria-labelledby="brand-preview">
      <header>
        <h2 id="brand-preview">Preview</h2>
        <BrandSegmented
          label="Preview theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: "dark", label: "Dark", icon: <Moon size={13} /> },
            { value: "light", label: "Light", icon: <Sun size={13} /> },
          ]}
        />
      </header>
      {identity.brand.signIn && (
        <BrandSegmented
          label="Preview surface"
          value={view}
          onChange={setView}
          options={[
            { value: "workspace", label: "Workspace" },
            { value: "sign-in", label: "Sign-in page" },
          ]}
        />
      )}
      <div className="cloud-brand-canvas" data-theme={theme} style={style}>
        <div className="cloud-brand-tab">
          {mark}
          <span>{name}</span>
          <X size={12} aria-hidden="true" />
        </div>
        {view === "workspace" ? (
          <div
            className="cloud-brand-app"
            data-tint={identity.brand.tintedSidebar ? "" : undefined}
          >
            <div className="cloud-brand-app-sidebar">
              <div className="cloud-brand-app-identity">
                {mark}
                <strong>{name}</strong>
              </div>
              {navigation.map(({ label, icon: Icon }, index) => (
                <span
                  key={label}
                  className="cloud-brand-app-item"
                  data-active={index === 1 ? "" : undefined}
                >
                  <Icon size={13} aria-hidden="true" />
                  {label}
                </span>
              ))}
            </div>
            <div className="cloud-brand-app-main">
              <div className="cloud-brand-app-heading">
                <strong>Issues</strong>
                <span className="cloud-brand-app-button">New issue</span>
              </div>
              {[72, 54, 64].map((width, index) => (
                <div key={width} className="cloud-brand-app-row">
                  <span data-done={index === 0 ? "" : undefined} />
                  <i style={{ width: `${width}%` }} />
                </div>
              ))}
              <div className="cloud-brand-app-progress">
                <span style={{ width: "62%" }} />
              </div>
            </div>
          </div>
        ) : (
          <div className="cloud-brand-signin">
            <div className="cloud-brand-signin-identity">
              {mark}
              <strong>{name}</strong>
            </div>
            <div className="cloud-brand-signin-card">
              <i />
              <i />
              <span className="cloud-brand-app-button">Sign in</span>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
