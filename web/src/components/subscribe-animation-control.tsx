import type { SubscribeAnimationConfig } from "../types";

export function SubscribeAnimationControl({ value, onChange, longForm = false }: {
  value: SubscribeAnimationConfig;
  onChange: (value: SubscribeAnimationConfig) => void;
  longForm?: boolean;
}) {
  return <fieldset className="subscribe-animation-control">
    <legend>Automatic Subscribe animation</legend>
    <label><input type="checkbox" checked={value.enabled} onChange={(event) => onChange({ ...value, enabled: event.target.checked })} /> Enable Subscribe animation</label>
    <label className="subscribe-animation-timing">Short-form timing <select aria-label="Subscribe animation timing" value={value.shortFormLeadSeconds} disabled={!value.enabled || longForm} onChange={(event) => onChange({ ...value, shortFormLeadSeconds: Number(event.target.value) as 5 | 10 })}><option value={5}>5 seconds before the end</option><option value={10}>10 seconds before the end</option></select></label>
    <small>{longForm ? "Long-form outputs play once at the midpoint and again starting 30 seconds before the end (or once in the final five seconds if those occurrences are too close). The 5/10-second choice applies only to short form." : "For short-form videos, the animation appears 5 or 10 seconds before the ending."}</small>
  </fieldset>;
}
