/**
 * Action sheet confirmation dialog.
 */

interface ConfirmationDialogProps {
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
}

export function ConfirmationDialog({
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  destructive = false,
}: ConfirmationDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center pb-6">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      <div className="relative w-[calc(100%-24px)] max-w-xs">
        <div className="bg-white/95 backdrop-blur rounded-xl overflow-hidden mb-2">
          <div className="px-4 py-3 text-center border-b border-[#c6c6c8]">
            <p className="text-[13px] text-[#8e8e93]">{message}</p>
          </div>
          <button
            onClick={onConfirm}
            className={`w-full py-3.5 text-[17px] font-normal ${
              destructive ? "text-[#ff3b30]" : "text-[#007aff]"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
        <button
          onClick={onCancel}
          className="w-full py-3.5 text-[17px] font-semibold text-[#007aff] bg-white rounded-xl"
        >
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
