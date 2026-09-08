import type {
  DutyBlock,
  DutyLocationBlockAssignmentMode,
  DutyLocationBlockPolicyInput,
} from "../../lib/dutyLocations/types";

interface Props {
  blocks: DutyBlock[];
  value: DutyLocationBlockPolicyInput[];
  onChange: (value: DutyLocationBlockPolicyInput[]) => void;
  disabled?: boolean;
}

function modeOf(value: DutyLocationBlockPolicyInput[], blockId: string): DutyLocationBlockAssignmentMode {
  return value.find((policy) => policy.dutyBlockId === blockId)?.assignmentMode ?? "off";
}

export default function DutyLocationBlockPolicyEditor({ blocks, value, onChange, disabled = false }: Props) {
  const morning = blocks.find((block) => block.code === "MORNING_BREAKS");
  const afternoon = blocks.find((block) => block.code === "AFTERNOON_BREAKS");
  const lunch1 = blocks.find((block) => block.code === "LONG_BREAK_1");
  const lunch2 = blocks.find((block) => block.code === "LONG_BREAK_2");

  function setModes(blockIds: string[], assignmentMode: DutyLocationBlockAssignmentMode) {
    onChange(
      blocks.map((block) => ({
        dutyBlockId: block.id,
        assignmentMode: blockIds.includes(block.id) ? assignmentMode : modeOf(value, block.id),
      })),
    );
  }

  if (!morning || !afternoon || !lunch1 || !lunch2) {
    return <p className="dl-field-error">Dört nöbet bloğu yüklenemedi; bu kayıt kaydedilemez.</p>;
  }

  const breakMode = modeOf(value, morning.id);
  return (
    <fieldset className="dl-block-policy" disabled={disabled}>
      <legend>Nöbet blokları</legend>
      <p className="dl-field-hint">
        Teneffüs görevi Sabah ve Öğleden Sonra bloklarını tek paket olarak kapsar. Öğle görevleri ayrı atanır.
      </p>
      <label>
        <span><strong>Teneffüs</strong><small>Sabah + Öğleden Sonra</small></span>
        <select
          aria-label="Teneffüs blok politikası"
          value={breakMode}
          onChange={(event) => setModes([morning.id, afternoon.id], event.target.value as DutyLocationBlockAssignmentMode)}
        >
          <option value="off">Kapalı</option>
          <option value="normal">Normal atama</option>
          <option value="fixed_only">Yalnız sabit nöbet</option>
        </select>
      </label>
      {[lunch1, lunch2].map((block, index) => (
        <label key={block.id}>
          <span><strong>Öğle Arası-{index + 1}</strong><small>Tek blok görevi</small></span>
          <select
            aria-label={`Öğle Arası-${index + 1} blok politikası`}
            value={modeOf(value, block.id)}
            onChange={(event) => setModes([block.id], event.target.value as DutyLocationBlockAssignmentMode)}
          >
            <option value="off">Kapalı</option>
            <option value="normal">Normal atama</option>
          </select>
        </label>
      ))}
    </fieldset>
  );
}
