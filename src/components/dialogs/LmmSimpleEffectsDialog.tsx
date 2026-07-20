/**
 * LMM Simple Effects Dialog
 *
 * Thin wrapper over SimpleEffectsSelectionBase with LMM-specific copy.
 *
 * Adjustment method is configured in the main LmmAnovaConfigDialog, so
 * showAdjustmentControls is always false here.
 */

import {
  SimpleEffectsSelectionBase,
  type SimpleEffectsSelectionBaseProps,
} from './SimpleEffectsSelectionBase'

type LmmSimpleEffectsDialogProps = Omit<
  SimpleEffectsSelectionBaseProps,
  | 'title'
  | 'description'
  | 'explanationNode'
  | 'adjustmentHelpText'
  | 'showExampleInterpretation'
  | 'showAdjustmentControls'
>

export function LmmSimpleEffectsDialog(props: LmmSimpleEffectsDialogProps) {
  const primaryFactor = props.factorNames[0] ?? 'Treatment'
  const withinFactor = props.factorNames[1] ?? 'Day'

  return (
    <SimpleEffectsSelectionBase
      title="LMM Simple Effects"
      description="Choose follow-up simple effects for the predictors that remain inside each subgroup or pooled mixed model."
      explanationNode={
        <>
          <p className="font-medium mb-2">What are simple effects in mixed models?</p>
          <p className="text-xs leading-relaxed">
            Simple effects test one predictor while holding another constant, fit within the same
            mixed model as the main analysis. For example, &ldquo;{primaryFactor} within{' '}
            {withinFactor}&rdquo; tests whether Drug A vs Control differs at each {withinFactor}{' '}
            level. Use this to follow up significant interactions found in your lmer model. The
            post-hoc adjustment method set in the LMM configuration dialog applies to these
            comparisons.
          </p>
        </>
      }
      showExampleInterpretation
      showAdjustmentControls={false}
      {...props}
    />
  )
}
