"use client";

import {
  Circle,
  Image as ImageIcon,
  RotateCcw,
  Shapes,
  Square,
  SquareRoundCorner,
  Type,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CloudOrganization } from "@/lib/cloud-administration-contract";
import {
  brandIcons,
  defaultOrganizationBrand,
  organizationInitials,
  type OrganizationBrand,
} from "@/lib/organization-brand";
import { createCommandSender } from "./api-client";
import {
  BrandColorField,
  BrandSegmented,
  BrandSwitch,
  moveRadioSelection,
} from "./brand-controls";
import { BrandLogoField } from "./brand-logo-field";
import { brandIconComponents } from "./brand-mark";
import { BrandPreview } from "./brand-preview";
import { useToast } from "./toast";

interface BrandDraft {
  name: string;
  brand: OrganizationBrand;
  logo: string | null;
}

const draftKeys = [
  "name",
  "brand",
  "logo",
  ...Object.keys(defaultOrganizationBrand),
];

function sameDraft(first: unknown, second: unknown): boolean {
  return JSON.stringify(first, draftKeys) === JSON.stringify(second, draftKeys);
}

function draftOf(organization: CloudOrganization): BrandDraft {
  return {
    name: organization.name,
    brand: organization.brand,
    logo: organization.logo,
  };
}

export function OrganizationBranding({
  organization,
}: {
  organization: CloudOrganization;
}) {
  const router = useRouter();
  const toast = useToast();
  const sender = useRef(createCommandSender());
  const [draft, setDraft] = useState(() => draftOf(organization));
  const [savedRevision, setSavedRevision] = useState(organization.revision);
  const [gradientColor, setGradientColor] = useState(
    organization.brand.gradient ?? "#f39ad6",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (organization.revision !== savedRevision) {
    setSavedRevision(organization.revision);
    setDraft(draftOf(organization));
  }
  const saved = draftOf(organization);
  const dirty = !sameDraft(draft, saved);
  const missingImage = draft.brand.mark === "image" && !draft.logo;
  const brandChanged = !sameDraft(draft.brand, {
    ...defaultOrganizationBrand,
    signIn: draft.brand.signIn,
  });
  const updateBrand = (change: Partial<OrganizationBrand>) =>
    setDraft((current) => ({
      ...current,
      brand: { ...current.brand, ...change },
    }));
  const save = () => {
    setSaving(true);
    setError("");
    void sender
      .current(
        "organization",
        {
          revision: organization.revision,
          name: draft.name.trim(),
          brand: draft.brand,
          logo: draft.logo,
        },
        "PATCH",
      )
      .then(() => {
        toast("Organization saved.");
        router.refresh();
      })
      .catch((reason: unknown) =>
        setError(
          reason instanceof Error
            ? reason.message
            : "Changes could not be saved. Try again.",
        ),
      )
      .finally(() => setSaving(false));
  };
  return (
    <form
      className="cloud-brand-editor"
      aria-labelledby="organization-heading"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !missingImage && !saving) save();
      }}
    >
      <h2 id="organization-heading" className="sr-only">
        Organization
      </h2>
      <div className="cloud-brand-form">
        <section
          className="cloud-settings-section"
          aria-labelledby="brand-identity"
        >
          <header>
            <h2 id="brand-identity">Identity</h2>
          </header>
          <Field label="Name" htmlFor="organization-name">
            <Input
              id="organization-name"
              required
              maxLength={120}
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
            />
          </Field>
          <div className="grid gap-3">
            <span className="cloud-brand-label">Mark</span>
            <BrandSegmented
              label="Mark"
              value={draft.brand.mark}
              onChange={(mark) => updateBrand({ mark })}
              options={[
                { value: "icon", label: "Icon", icon: <Shapes size={14} /> },
                {
                  value: "initials",
                  label: "Initials",
                  icon: <Type size={14} />,
                },
                {
                  value: "image",
                  label: "Image",
                  icon: <ImageIcon size={14} />,
                },
              ]}
            />
            {draft.brand.mark === "icon" && (
              <div
                role="radiogroup"
                aria-label="Icon"
                className="cloud-brand-icons"
                onKeyDown={(event) =>
                  moveRadioSelection(
                    event,
                    brandIcons,
                    draft.brand.icon,
                    (icon) => updateBrand({ icon }),
                  )
                }
              >
                {brandIcons.map((icon) => {
                  const Icon = brandIconComponents[icon];
                  const selected = icon === draft.brand.icon;
                  return (
                    <button
                      key={icon}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={icon[0]!.toUpperCase() + icon.slice(1)}
                      title={icon[0]!.toUpperCase() + icon.slice(1)}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => updateBrand({ icon })}
                    >
                      <Icon size={17} />
                    </button>
                  );
                })}
              </div>
            )}
            {draft.brand.mark === "initials" && (
              <Field label="Initials" htmlFor="organization-initials">
                <Input
                  id="organization-initials"
                  className="cloud-brand-initials-input"
                  maxLength={2}
                  placeholder={organizationInitials(draft.name)}
                  value={draft.brand.initials}
                  onChange={(event) =>
                    updateBrand({
                      initials: event.target.value
                        .replace(/[^\p{L}\p{N}]/gu, "")
                        .toUpperCase(),
                    })
                  }
                />
              </Field>
            )}
            {draft.brand.mark === "image" && (
              <BrandLogoField
                logo={draft.logo}
                onChange={(logo) =>
                  setDraft((current) => ({ ...current, logo }))
                }
              />
            )}
          </div>
          <div className="grid gap-3">
            <span className="cloud-brand-label">Shape</span>
            <BrandSegmented
              label="Shape"
              value={draft.brand.shape}
              onChange={(shape) => updateBrand({ shape })}
              options={[
                {
                  value: "rounded",
                  label: "Rounded",
                  icon: <SquareRoundCorner size={14} />,
                },
                {
                  value: "circle",
                  label: "Circle",
                  icon: <Circle size={14} />,
                },
                {
                  value: "square",
                  label: "Square",
                  icon: <Square size={14} />,
                },
              ]}
            />
          </div>
        </section>
        <section
          className="cloud-settings-section"
          aria-labelledby="brand-colors"
        >
          <header>
            <h2 id="brand-colors">Colors</h2>
          </header>
          <BrandColorField
            id="brand-color"
            label="Brand color"
            value={draft.brand.color}
            onChange={(color) => updateBrand({ color })}
          />
          <BrandSwitch
            id="brand-gradient"
            label="Gradient"
            checked={draft.brand.gradient !== null}
            onChange={(enabled) =>
              updateBrand({ gradient: enabled ? gradientColor : null })
            }
          />
          {draft.brand.gradient !== null && (
            <BrandColorField
              id="brand-gradient-color"
              label="Gradient color"
              value={draft.brand.gradient}
              onChange={(gradient) => {
                setGradientColor(gradient);
                updateBrand({ gradient });
              }}
            />
          )}
          <BrandSwitch
            id="brand-tint"
            label="Tinted sidebar"
            checked={draft.brand.tintedSidebar}
            onChange={(tintedSidebar) => updateBrand({ tintedSidebar })}
          />
        </section>
        <section
          className="cloud-settings-section"
          aria-labelledby="brand-sign-in"
        >
          <header>
            <h2 id="brand-sign-in">Sign-in page</h2>
          </header>
          <BrandSwitch
            id="brand-sign-in-toggle"
            label="Show branding on sign-in page"
            checked={draft.brand.signIn}
            onChange={(signIn) => updateBrand({ signIn })}
          >
            <small>Name, mark and colors become visible before sign-in.</small>
          </BrandSwitch>
        </section>
      </div>
      <div className="cloud-brand-side">
        <BrandPreview identity={draft} />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!brandChanged}
          onClick={() =>
            setDraft((current) => ({
              ...current,
              brand: {
                ...defaultOrganizationBrand,
                signIn: current.brand.signIn,
              },
            }))
          }
        >
          <RotateCcw />
          Restore default look
        </Button>
      </div>
      {(dirty || error) && (
        <div
          className="cloud-brand-savebar"
          role="region"
          aria-label="Unsaved changes"
        >
          {error ? (
            <p role="alert">{error}</p>
          ) : (
            <p>
              {missingImage
                ? "Upload an image to use it as the mark."
                : "Unsaved changes"}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => {
              setDraft(saved);
              setError("");
            }}
          >
            Discard
          </Button>
          <Button
            type="submit"
            disabled={saving || missingImage || !dirty || !draft.name.trim()}
          >
            {saving ? "Saving…" : "Save organization"}
          </Button>
        </div>
      )}
    </form>
  );
}
