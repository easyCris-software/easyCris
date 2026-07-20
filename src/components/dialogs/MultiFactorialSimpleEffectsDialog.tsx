/**
 * Multi-Factorial Simple Effects Dialog (ANOVA / Scheirer-Ray-Hare)
 *
 * Thin wrapper over SimpleEffectsSelectionBase with ANOVA-specific copy.
 */

import {
  SimpleEffectsSelectionBase,
  type SimpleEffectsSelectionBaseProps,
} from './SimpleEffectsSelectionBase'

type MultiFactorialSimpleEffectsDialogProps = Omit<
  SimpleEffectsSelectionBaseProps,
  'title' | 'description' | 'explanationNode' | 'adjustmentHelpText' | 'showExampleInterpretation'
> & {
  /** Number of factors, used to build the description string. */
  factorNames: string[]
}

export function MultiFactorialSimpleEffectsDialog({
  factorNames,
  ...rest
}: MultiFactorialSimpleEffectsDialogProps) {
  const description = `Select which simple effects to analyze for your ${
    factorNames.length > 0 ? `${factorNames.length}-factor` : 'multi-factorial'
  } ANOVA / Scheirer-Ray-Hare design`

  return (
    <SimpleEffectsSelectionBase
      title="Multi-Factorial Simple Effects (ANOVA)"
      description={description}
      explanationNode={
        <>
          <p className="font-medium mb-2">What are simple effects in multi-factorial designs?</p>
          <p className="text-xs leading-relaxed">
            Simple effects test one factor while holding another factor constant. For example,
            &ldquo;Drug effect within Dose=Low&rdquo; tests whether Drug has an effect when Dose is
            at the Low level. This helps decompose complex interaction patterns.
          </p>
        </>
      }
      adjustmentHelpText="Tukey HSD is the default for ANOVA. Dunnett requires control levels for each factor."
      showExampleInterpretation
      factorNames={factorNames}
      {...rest}
    />
  )
}
