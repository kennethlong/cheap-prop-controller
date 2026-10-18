import { BOARD_PROFILES, feedbackPins, pinLabel } from "../shared/boards";
import type { BoardId } from "../shared/model";

export function HardwarePinSelect({
  board,
  value,
  label,
  feedback = false,
  onChange,
}: {
  board: BoardId;
  value: number | null;
  label: string;
  feedback?: boolean;
  onChange(pin: number | null): void;
}) {
  const pins = feedback
    ? feedbackPins(board)
    : BOARD_PROFILES[board].digitalPins.filter(
        (pin) => !BOARD_PROFILES[board].reservedPins.includes(pin),
      );
  return (
    <select
      aria-label={label}
      value={value ?? ""}
      onChange={(event) =>
        onChange(event.target.value === "" ? null : Number(event.target.value))
      }
    >
      <option value="">Unassigned</option>
      {value !== null && !pins.includes(value) && (
        <option value={value}>Unavailable pin {value}</option>
      )}
      {pins.map((pin) => (
        <option key={pin} value={pin}>
          {pinLabel(board, pin)}
        </option>
      ))}
    </select>
  );
}
