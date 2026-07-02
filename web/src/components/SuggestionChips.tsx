const CHIPS: { label: string; prompt: string }[] = [
  { label: "Compare dev vs prod", prompt: "Compare mycontracts api in dev and prod" },
  { label: "Check revisions", prompt: "List number of revisions in 4600-HRAPI in sandbox" },
  { label: "Promote an API", prompt: "Promote checkout-api from dev to sandbox" },
  { label: "Onboard new API", prompt: "Onboard a new API called billing-api" },
];

export default function SuggestionChips({
  onSelect,
  disabled,
}: {
  onSelect: (prompt: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="shrink-0 px-4 pb-2 flex gap-2 overflow-x-auto no-scrollbar">
      {CHIPS.map((chip) => (
        <button
          key={chip.label}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(chip.prompt)}
          className="chip shrink-0 text-[12.5px] font-medium text-[var(--ink-600)] bg-white border border-[var(--line)] rounded-full px-3.5 py-1.5 disabled:opacity-40 disabled:pointer-events-none"
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}
