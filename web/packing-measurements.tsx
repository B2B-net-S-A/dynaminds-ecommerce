import { useId } from 'react';
import {
  packingMeasurementFields as fields,
  packingUnitText as unitText,
  validatePackingMeasurementsDraft,
} from './packing-measurements-input';
import type {
  PackingCartonSeed,
  PackingMeasurementDraftField as DraftField,
  PackingMeasurementsDraft,
  PackingMeasurementsValidation,
} from './packing-measurements-input';
import { ScaleWeightButton } from './scale-weight';
import './packing-measurements.css';

export { validatePackingMeasurementsDraft } from './packing-measurements-input';
export type {
  PackingMeasurements,
  PackingCartonSeed,
  PackingMeasurementsDraft,
  PackingMeasurementsValidation,
} from './packing-measurements-input';

export type PackingMeasurementsFormProps = {
  draft: PackingMeasurementsDraft;
  onChange: (
    draft: PackingMeasurementsDraft,
    validation: PackingMeasurementsValidation,
    source: 'edit' | 'carton_dimensions' | 'scale',
  ) => void;
  disabled?: boolean;
  readOnly?: boolean;
  carton?: PackingCartonSeed | null;
  showErrors?: boolean;
};

export function PackingMeasurementsForm({
  draft,
  onChange,
  disabled = false,
  readOnly = false,
  carton,
  showErrors = false,
}: PackingMeasurementsFormProps) {
  const id = useId();
  const validation = validatePackingMeasurementsDraft(draft);
  const locked = disabled || readOnly;
  const cartonDimensions =
    carton &&
    [carton.outer_length_mm, carton.outer_width_mm, carton.outer_height_mm].every(
      (value) => Number.isSafeInteger(value) && value >= 1 && value <= 3000,
    );
  const cartonWeight =
    carton && Number.isSafeInteger(carton.tare_weight_grams) && carton.tare_weight_grams >= 0;

  function change(field: DraftField, raw: string, source: 'edit' | 'scale' = 'edit') {
    if (locked) return;
    const next = { ...draft, [field]: raw };
    onChange(next, validatePackingMeasurementsDraft(next), source);
  }

  function useCartonDimensions() {
    if (locked || !carton || !cartonDimensions) return;
    const next = {
      ...draft,
      length_cm: unitText(carton.outer_length_mm, 1),
      width_cm: unitText(carton.outer_width_mm, 1),
      height_cm: unitText(carton.outer_height_mm, 1),
    };
    onChange(next, validatePackingMeasurementsDraft(next), 'carton_dimensions');
  }

  return (
    <fieldset className="packing-measurements" disabled={disabled} aria-describedby={id + '-help'}>
      <legend>Rzeczywisty pomiar gotowej paczki</legend>
      <p className="packing-measurements-help" id={id + '-help'}>
        Zmierz gotową paczkę z opakowaniem i wypełnieniem. Podaj wszystkie cztery wartości: masę do
        trzech miejsc po przecinku, wymiary do jednego. Przecinek i kropka są dozwolone.
      </p>
      {carton && (
        <div className="packing-measurements-carton">
          <strong>
            Karton: {carton.code} — {carton.label}
          </strong>
          {cartonDimensions ? (
            <p>
              Wymiary zewnętrzne: {unitText(carton.outer_length_mm, 1)} ×{' '}
              {unitText(carton.outer_width_mm, 1)} × {unitText(carton.outer_height_mm, 1)} cm.
            </p>
          ) : (
            <p role="alert">Wymiary kartonu są poza zakresem formularza lub są nieprawidłowe.</p>
          )}
          <p>
            Masa samego kartonu:{' '}
            {cartonWeight
              ? unitText(carton.tare_weight_grams, 3) + ' kg.'
              : 'brak poprawnego pomiaru.'}{' '}
            To informacja pomocnicza; masa gotowej paczki wymaga pomiaru.
          </p>
          <button
            type="button"
            className="button"
            disabled={locked || !cartonDimensions}
            onClick={useCartonDimensions}
          >
            Użyj wymiarów kartonu
          </button>
          <p className="packing-measurements-help">
            Przycisk wpisuje wymiary do szkicu. Potwierdzenie rzeczywistego pomiaru odbywa się w
            podglądzie pakowania.
          </p>
        </div>
      )}
      <div className="packing-measurements-grid">
        {fields.map((field) => {
          const error = validation.errors[field.draft];
          const visibleError = !!error && (showErrors || draft[field.draft] !== '');
          const inputId = id + '-' + field.draft;
          return (
            <div className="packing-measurements-field" key={field.draft}>
              <label htmlFor={inputId}>{field.label}</label>
              <input
                id={inputId}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={draft[field.draft]}
                required
                readOnly={readOnly}
                aria-invalid={visibleError}
                aria-describedby={
                  inputId + '-range' + (visibleError ? ' ' + inputId + '-error' : '')
                }
                onChange={(event) => change(field.draft, event.target.value)}
              />
              <small id={inputId + '-range'}>Zakres: {field.range}</small>
              {field.draft === 'weight_kg' && !readOnly && (
                <ScaleWeightButton
                  disabled={locked}
                  onWeight={(grams) => change('weight_kg', unitText(grams, 3), 'scale')}
                />
              )}
              {visibleError && (
                <p className="packing-measurements-error" id={inputId + '-error'} role="alert">
                  {error}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {validation.measurements && (
        <p className="packing-measurements-exact" role="status">
          Pomiar w jednostkach zapisu: {validation.measurements.weight_grams} g;{' '}
          {validation.measurements.length_mm} × {validation.measurements.width_mm} ×{' '}
          {validation.measurements.height_mm} mm.
        </p>
      )}
      {readOnly && (
        <p className="packing-measurements-help">Pomiar jest dostępny tylko do odczytu.</p>
      )}
    </fieldset>
  );
}
