const toArrayOfStrings = (opts) => {
  if (typeof opts === "string") return opts.split(",").map((s) => s.trim());
  if (Array.isArray(opts))
    return opts.map((o) => (typeof o === "string" ? o : o.value || o.name));
};

const fieldProperties = (field) => {
  const props = {};
  const typeName = field.type?.name || field.type || field.input_type;
  if (field.isRepeat) {
    props.type = "array";
    const properties = {};
    field.fields.map((f) => {
      properties[f.name] = {
        description: f.sublabel || f.label,
        ...fieldProperties(f),
      };
    });
    props.items = {
      type: "object",
      properties,
    };
  }
  switch (typeName) {
    case "String":
      props.type = "string";
      if (field.attributes?.options)
        props.enum = toArrayOfStrings(field.attributes.options);
      break;
    case "Bool":
      props.type = "boolean";
      break;
    case "Integer":
      props.type = "integer";
      break;
    case "Float":
      props.type = "number";
      break;
    case "select":
      props.type = "string";
      if (field.options) props.enum = toArrayOfStrings(field.options);
      break;
  }
  if (!props.type) {
    switch (field.input_type) {
      case "code":
        props.type = "string";
        break;
    }
  }
  return props;
};

module.exports = { fieldProperties };
