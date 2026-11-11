// Code-owned exact native SQL bodies; catalogue-only predispatch expectations.
export const PACKING_FIELD_ROUTINES = Object.freeze([
  {
    "identity": "public.packing_required_field_valid(jsonb,jsonb,jsonb,jsonb,jsonb)",
    "body_sha256": "c2782c0a82efed2eb49e97858d963e6e175e40fd8919440a48d2f719ca87c922",
    "returns": "boolean",
    "volatility": "i",
    "app_execute": true,
    "argument_names": [
      "field_def",
      "field_value",
      "value_revision",
      "field_options",
      "field_file"
    ]
  },
  {
    "identity": "public.packing_required_fields_snapshot(uuid)",
    "body_sha256": "5ad086377c6693e35831c8e5c879475898ab0124d07ebff58f4f1b7c3611f2cd",
    "returns": "jsonb",
    "volatility": "v",
    "app_execute": true,
    "argument_names": [
      "p_order"
    ]
  },
  {
    "identity": "public.packing_required_fields_require(uuid)",
    "body_sha256": "b74c6e60e55cf08067e27295c437002c87b485c271713520c057dd6f886771c0",
    "returns": "void",
    "volatility": "v",
    "app_execute": true,
    "argument_names": [
      "p_order"
    ]
  },
  {
    "identity": "public.packing_required_fields_guard()",
    "body_sha256": "291fd1bea4761821c1ecfec33d911cc293b45fddce7ed43c6757ae9330887e2f",
    "returns": "trigger",
    "volatility": "v",
    "app_execute": false,
    "argument_names": null
  }
].map(entry => Object.freeze({...entry, argument_names: entry.argument_names === null ? null : Object.freeze([...entry.argument_names])})));
