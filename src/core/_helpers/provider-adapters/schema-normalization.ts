const isSchemaRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const schemaAllowsNull = (schema: Record<string, unknown>): boolean => {
  if (schema.const === null) {
    return true;
  }

  if (Array.isArray(schema.enum) && schema.enum.includes(null)) {
    return true;
  }

  if (schema.type === "null") {
    return true;
  }

  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    return true;
  }

  for (const key of ["anyOf", "oneOf"] as const) {
    const options = schema[key];

    if (
      Array.isArray(options) &&
      options.some(
        (option) => isSchemaRecord(option) && schemaAllowsNull(option),
      )
    ) {
      return true;
    }
  }

  return false;
};

const makeSchemaNullable = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  if (schemaAllowsNull(schema)) {
    return schema;
  }

  const nullableSchema: Record<string, unknown> = { ...schema };

  if (
    Array.isArray(nullableSchema.enum) &&
    !nullableSchema.enum.includes(null)
  ) {
    nullableSchema.enum = [...nullableSchema.enum, null];
  }

  if (typeof nullableSchema.type === "string") {
    nullableSchema.type = [nullableSchema.type, "null"];
    return nullableSchema;
  }

  if (Array.isArray(nullableSchema.type)) {
    nullableSchema.type = nullableSchema.type.includes("null")
      ? nullableSchema.type
      : [...nullableSchema.type, "null"];
    return nullableSchema;
  }

  if (Array.isArray(nullableSchema.anyOf)) {
    nullableSchema.anyOf = [...nullableSchema.anyOf, { type: "null" }];
    return nullableSchema;
  }

  if (Array.isArray(nullableSchema.oneOf)) {
    nullableSchema.oneOf = [...nullableSchema.oneOf, { type: "null" }];
    return nullableSchema;
  }

  return {
    anyOf: [nullableSchema, { type: "null" }],
  };
};

export const normalizeOpenAIStrictInputSchema = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  const normalizedSchema: Record<string, unknown> = { ...schema };
  delete normalizedSchema.propertyNames;

  if (Array.isArray(schema.items)) {
    normalizedSchema.items = schema.items.map((item) =>
      isSchemaRecord(item) ? normalizeOpenAIStrictInputSchema(item) : item,
    );
  } else if (isSchemaRecord(schema.items)) {
    normalizedSchema.items = normalizeOpenAIStrictInputSchema(schema.items);
  }

  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const variants = schema[key];

    if (Array.isArray(variants)) {
      normalizedSchema[key] = variants.map((variant) =>
        isSchemaRecord(variant)
          ? normalizeOpenAIStrictInputSchema(variant)
          : variant,
      );
    }
  }

  if (isSchemaRecord(schema.not)) {
    normalizedSchema.not = normalizeOpenAIStrictInputSchema(schema.not);
  }

  const properties = isSchemaRecord(schema.properties)
    ? schema.properties
    : null;
  const hasObjectType =
    schema.type === "object" ||
    (Array.isArray(schema.type) && schema.type.includes("object")) ||
    properties !== null;

  if (hasObjectType) {
    normalizedSchema.additionalProperties = false;
  }

  if (!properties) {
    if (hasObjectType) {
      normalizedSchema.required = [];
    }

    return normalizedSchema;
  }

  const originalRequired = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
  );
  const normalizedProperties = Object.fromEntries(
    Object.entries(properties).map(([propertyName, propertySchema]) => {
      if (!isSchemaRecord(propertySchema)) {
        return [propertyName, propertySchema];
      }

      const normalizedPropertySchema =
        normalizeOpenAIStrictInputSchema(propertySchema);

      return [
        propertyName,
        originalRequired.has(propertyName)
          ? normalizedPropertySchema
          : makeSchemaNullable(normalizedPropertySchema),
      ];
    }),
  );

  normalizedSchema.properties = normalizedProperties;
  normalizedSchema.required = Object.keys(normalizedProperties);

  return normalizedSchema;
};
