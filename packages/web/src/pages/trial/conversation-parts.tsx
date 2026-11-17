import { IconBan, IconCheck, IconX } from "../../components/icons.tsx";

export const STATUS_ICON = {
  passed: <IconCheck size={12} />,
  failed: <IconX size={12} />,
  unchecked: <IconBan size={12} />,
};

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="conv-field">
      <div className="conv-field-l">{label}</div>
      {children}
    </div>
  );
}

export function Json({ v }: { v: unknown }) {
  const text = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return <pre className="mono conv-json">{text}</pre>;
}
