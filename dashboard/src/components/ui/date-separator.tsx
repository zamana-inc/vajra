/**
 * Date separator for chat messages.
 */

interface DateSeparatorProps {
  label: string;
}

export function DateSeparator({ label }: DateSeparatorProps) {
  return (
    <div className="flex justify-center py-2">
      <span className="text-[11px] text-[#8e8e93] font-medium">{label}</span>
    </div>
  );
}
