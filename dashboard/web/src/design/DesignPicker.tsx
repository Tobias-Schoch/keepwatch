import { Check } from "lucide-react";
import { DESIGNS, setDesign, useDesign } from "./theme";
import { cx } from "./ui";
import "./themes/picker.css";

/**
 * The three designs side by side, each with a small preview in its own colors (the preview
 * never follows the active design). One click switches; stored in this browser only.
 */
export function DesignPicker() {
  const design = useDesign();
  return (
    <div className="d-designs" role="radiogroup" aria-label="Design">
      {DESIGNS.map((d) => {
        const on = d.id === design;
        return (
          <button key={d.id} type="button" role="radio" aria-checked={on} className={cx("d-design", on && "is-on")} onClick={() => setDesign(d.id)}>
            <span className="d-design-pv" data-pv={d.id} aria-hidden>
              <i />
              <i />
              <i />
            </span>
            <span className="d-design-name">
              {d.name}
              {on && <Check className="h-4 w-4" aria-hidden />}
            </span>
            <span className="d-design-blurb">{d.blurb}</span>
          </button>
        );
      })}
    </div>
  );
}
