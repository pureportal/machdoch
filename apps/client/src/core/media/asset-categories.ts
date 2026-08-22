import type {
  MediaAssetCategory,
  MediaGenerationAssetMetadata,
} from "./contracts.js";

const MAX_CATEGORY_COUNT = 100;
const MAX_CATEGORY_NAME_LENGTH = 64;

export const DEFAULT_MEDIA_ASSET_CATEGORIES: readonly MediaAssetCategory[] = [
  { id: "character", name: "Character" },
  { id: "style", name: "Style" },
  { id: "concept", name: "Concept" },
  { id: "pose-action", name: "Pose & Action" },
  { id: "clothing-accessories", name: "Clothing & Accessories" },
  { id: "environment-background", name: "Environment & Background" },
  { id: "architecture", name: "Architecture" },
  { id: "object-prop", name: "Object & Prop" },
  { id: "animal-creature", name: "Animal & Creature" },
  { id: "vehicle", name: "Vehicle" },
  { id: "photography", name: "Photography" },
  { id: "illustration", name: "Illustration" },
  { id: "animation-motion", name: "Animation & Motion" },
  { id: "ui-icon", name: "UI & Icon" },
  { id: "logo-branding", name: "Logo & Branding" },
  { id: "typography", name: "Typography" },
  { id: "texture-material", name: "Texture & Material" },
  { id: "lighting-color", name: "Lighting & Color" },
  { id: "product-mockup", name: "Product & Mockup" },
  { id: "nsfw-mature", name: "NSFW — Mature" },
  { id: "nsfw-adult", name: "NSFW — Adult" },
  { id: "nsfw-explicit", name: "NSFW — Explicit" },
];

export const normalizeMediaAssetCategoryName = (value: string): string =>
  value.replaceAll(/\s+/gu, " ").trim();

const normalizedComparisonName = (value: string): string =>
  normalizeMediaAssetCategoryName(value).toLocaleLowerCase();

const validatedCategoryName = (
  value: string,
  categories: readonly MediaAssetCategory[],
  categoryId?: string,
): string => {
  const name = normalizeMediaAssetCategoryName(value);
  if (!name) throw new Error("Enter a category name.");
  if (name.length > MAX_CATEGORY_NAME_LENGTH) {
    throw new Error(
      `Category names must be ${MAX_CATEGORY_NAME_LENGTH} characters or fewer.`,
    );
  }
  const comparisonName = normalizedComparisonName(name);
  if (
    categories.some(
      (category) =>
        category.id !== categoryId &&
        normalizedComparisonName(category.name) === comparisonName,
    )
  ) {
    throw new Error("A category with that name already exists.");
  }
  return name;
};

export const normalizeMediaAssetCategories = (
  value: unknown,
): MediaAssetCategory[] => {
  if (!Array.isArray(value)) return [];
  const categories: MediaAssetCategory[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const entry of value) {
    if (categories.length >= MAX_CATEGORY_COUNT) break;
    if (typeof entry !== "object" || entry === null) continue;
    if (!("id" in entry) || !("name" in entry)) continue;
    if (typeof entry.id !== "string" || typeof entry.name !== "string") {
      continue;
    }
    const id = entry.id.trim().slice(0, 128);
    const name = normalizeMediaAssetCategoryName(entry.name).slice(
      0,
      MAX_CATEGORY_NAME_LENGTH,
    );
    const comparisonName = normalizedComparisonName(name);
    if (!id || !name || ids.has(id) || names.has(comparisonName)) continue;
    ids.add(id);
    names.add(comparisonName);
    categories.push({ id, name });
  }
  return categories;
};

export const addMediaAssetCategory = (
  categories: readonly MediaAssetCategory[],
  name: string,
  id: string,
): MediaAssetCategory[] => {
  if (categories.length >= MAX_CATEGORY_COUNT) {
    throw new Error(
      `Media Studio supports up to ${MAX_CATEGORY_COUNT} categories.`,
    );
  }
  const normalizedId = id.trim();
  if (
    !normalizedId ||
    categories.some((category) => category.id === normalizedId)
  ) {
    throw new Error("The category identifier is invalid.");
  }
  return [
    ...categories,
    {
      id: normalizedId,
      name: validatedCategoryName(name, categories),
    },
  ];
};

export const renameMediaAssetCategory = (
  categories: readonly MediaAssetCategory[],
  categoryId: string,
  name: string,
): MediaAssetCategory[] => {
  if (!categories.some((category) => category.id === categoryId)) {
    throw new Error("The category no longer exists.");
  }
  const normalizedName = validatedCategoryName(name, categories, categoryId);
  return categories.map((category) =>
    category.id === categoryId
      ? { ...category, name: normalizedName }
      : category,
  );
};

export const removeMediaAssetCategory = (
  categories: readonly MediaAssetCategory[],
  metadata: Readonly<Record<string, MediaGenerationAssetMetadata>>,
  categoryId: string,
): {
  categories: MediaAssetCategory[];
  metadata: Record<string, MediaGenerationAssetMetadata>;
} => ({
  categories: categories.filter((category) => category.id !== categoryId),
  metadata: Object.fromEntries(
    Object.entries(metadata).map(([resourceId, entry]) => [
      resourceId,
      {
        ...entry,
        categoryIds: entry.categoryIds.filter(
          (assignedCategoryId) => assignedCategoryId !== categoryId,
        ),
      },
    ]),
  ),
});

export const mediaAssetCategoryNames = (
  categoryIds: readonly string[],
  categories: readonly MediaAssetCategory[],
): string[] => {
  const categoriesById = new Map(
    categories.map((category) => [category.id, category.name]),
  );
  return categoryIds.flatMap((categoryId) => {
    const name = categoriesById.get(categoryId);
    return name ? [name] : [];
  });
};

export const matchesMediaAssetCategoryFilter = (
  assignedCategoryIds: readonly string[],
  selectedCategoryIds: readonly string[],
): boolean =>
  selectedCategoryIds.length === 0 ||
  selectedCategoryIds.some((categoryId) =>
    assignedCategoryIds.includes(categoryId),
  );
