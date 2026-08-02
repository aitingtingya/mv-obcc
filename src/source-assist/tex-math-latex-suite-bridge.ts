import type { Extension } from "@codemirror/state";
import { editorInfoField } from "obsidian";
import {
  externalMathRegionsFacet,
  type ExternalMathRegion,
} from "../vendor/latex-suite/src/utils/context";
import { texMathRegionsField } from "./tex-math";

export function texMathLatexSuiteBridgeExtension(): Extension {
  return externalMathRegionsFacet.compute(
    [texMathRegionsField, editorInfoField],
    (state): readonly ExternalMathRegion[] => {
      const extension =
        state
          .field(editorInfoField, false)
          ?.file?.extension?.toLowerCase() ?? "";
      if (extension !== "tex") return [];
      return state.field(texMathRegionsField).map((region) => ({
        inner_start: region.inner_start,
        inner_end: region.inner_end,
        outer_start: region.outer_start,
        outer_end: region.outer_end,
        display: region.display,
        preview_source: region.renderSource,
        preview_source_start: region.renderSourceFrom,
      }));
    },
  );
}
