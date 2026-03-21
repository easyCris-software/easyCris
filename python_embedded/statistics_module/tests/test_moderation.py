"""
Unit tests for moderation analysis functions.
Tests both Model 1 (Simple Moderation) and Model 7 (Moderated Mediation).

Run with: pytest test_moderation.py -v
"""

import pytest
import json
import numpy as np
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from moderation import simple_moderation, moderated_mediation_model7


class TestSimpleModeration:
    """Tests for Model 1: Simple Moderation (X × W → Y)"""

    @pytest.fixture
    def sample_data(self):
        """Generate sample data for testing."""
        np.random.seed(42)
        n = 100

        # Generate data with known moderation effect
        x = np.random.normal(0, 1, n)
        w = np.random.normal(0, 1, n)
        # Y = 1 + 0.5*X + 0.3*W + 0.4*X*W + error
        y = 1 + 0.5*x + 0.3*w + 0.4*x*w + np.random.normal(0, 0.5, n)

        return {
            'outcome_data': y.tolist(),
            'predictor_data': x.tolist(),
            'moderator_data': w.tolist(),
            'outcome_name': 'Y',
            'predictor_name': 'X',
            'moderator_name': 'W'
        }

    def test_simple_moderation_returns_valid_json(self, sample_data):
        """Test that simple_moderation returns valid JSON."""
        json_input = json.dumps(sample_data)
        result = simple_moderation(json_input)

        # Should return valid JSON
        parsed = json.loads(result)
        assert 'success' in parsed
        assert parsed['success'] == True
        robust_meta = parsed.get('preprocessing', {}).get('robust_standard_errors', {})
        assert robust_meta.get('auto_selected') is True
        assert robust_meta.get('selected_type') in {'HC3', 'HC4', 'HC2'}
        assert 'covariance_matrix' in parsed

    def test_simple_moderation_contains_interaction_effect(self, sample_data):
        """Test that result contains interaction effect (X × W)."""
        json_input = json.dumps(sample_data)
        result = simple_moderation(json_input)
        parsed = json.loads(result)

        assert parsed['success'] == True
        assert 'interaction' in parsed
        interaction = parsed['interaction']
        assert 'term' in interaction
        assert 'coefficient' in interaction
        assert 'p' in interaction
        assert 'se' in interaction

    def test_simple_moderation_contains_conditional_effects(self, sample_data):
        """Test that result contains conditional effects at different W values."""
        json_input = json.dumps(sample_data)
        result = simple_moderation(json_input)
        parsed = json.loads(result)

        assert parsed['success'] == True
        assert 'conditional_effects' in parsed
        assert parsed.get('preprocessing', {}).get('probe_strategy', {}).get('source') == 'default'

        # Should have effects at -1 SD, Mean, +1 SD
        effects = parsed['conditional_effects']
        assert len(effects) >= 3

        # Each effect should have required fields
        for effect in effects:
            assert 'moderator_value' in effect
            assert 'effect' in effect
            assert 'se' in effect
            assert 'p_value' in effect

    def test_simple_moderation_contains_model_summary(self, sample_data):
        """Test that result contains model summary statistics."""
        json_input = json.dumps(sample_data)
        result = simple_moderation(json_input)
        parsed = json.loads(result)

        assert parsed['success'] == True
        assert 'model_summary' in parsed

        summary = parsed['model_summary']
        assert 'r_squared' in summary
        assert 'f_statistic' in summary
        assert 'n' in summary

    def test_simple_moderation_with_covariates(self, sample_data):
        """Test simple moderation with control variables."""
        np.random.seed(42)
        n = len(sample_data['outcome_data'])

        # Add covariates
        sample_data['control_data'] = [
            np.random.normal(0, 1, n).tolist(),
            np.random.normal(0, 1, n).tolist()
        ]
        sample_data['control_names'] = ['C1', 'C2']

        json_input = json.dumps(sample_data)
        result = simple_moderation(json_input)
        parsed = json.loads(result)

        assert parsed['success'] == True
        assert 'model_info' in parsed
        assert 'controls' in parsed['model_info']
        assert 'C1' in parsed['model_info']['controls']
        assert 'C2' in parsed['model_info']['controls']

    def test_simple_moderation_custom_probe_values(self, sample_data):
        """Test simple moderation with custom moderator probe values."""
        sample_data['probe_values'] = [-2.0, 0.0, 2.0]

        json_input = json.dumps(sample_data)
        result = simple_moderation(json_input)
        parsed = json.loads(result)

        assert parsed['success'] == True
        assert 'conditional_effects' in parsed

        # Should have effects at specified probe values
        effects = parsed['conditional_effects']
        probe_values = [e['moderator_value'] for e in effects]

        # Check that custom probe values were used
        assert any(abs(v - (-2.0)) < 0.01 for v in probe_values)
        assert any(abs(v - 0.0) < 0.01 for v in probe_values)
        assert any(abs(v - 2.0) < 0.01 for v in probe_values)

    def test_simple_moderation_reports_encoding_summary(self, sample_data):
        """Encoding summary should be returned when categorical encodings are provided."""
        sample_data['categorical_encodings'] = {'Group': {'Control': 0, 'Treatment': 1}}

        json_input = json.dumps(sample_data)
        result = simple_moderation(json_input)
        parsed = json.loads(result)

        assert parsed['success'] == True
        assert 'encoding_summary' in parsed
        assert len(parsed['encoding_summary']) >= 1

    def test_simple_moderation_with_robust_se(self, sample_data):
        """Robust SE metadata should be reported when requested."""
        sample_data['robust_se'] = 'HC3'

        json_input = json.dumps(sample_data)
        parsed = json.loads(simple_moderation(json_input))

        robust_info = parsed.get('preprocessing', {}).get('robust_standard_errors', {})
        assert robust_info.get('requested') == 'HC3'
        assert robust_info.get('selected_type') == 'HC3'
        assert robust_info.get('applied') is True
        assert parsed.get('apa_tables')

    def test_simple_moderation_insufficient_data(self):
        """Test that insufficient data returns error."""
        data = {
            'outcome_data': [1, 2, 3],
            'predictor_data': [1, 2, 3],
            'moderator_data': [1, 2, 3],
            'outcome_name': 'Y',
            'predictor_name': 'X',
            'moderator_name': 'W'
        }

        json_input = json.dumps(data)
        result = simple_moderation(json_input)
        parsed = json.loads(result)

        # Should either fail or warn about sample size
        if not parsed['success']:
            assert 'error' in parsed
        else:
            # If it succeeds, should have a warning
            assert 'warnings' in parsed or len(parsed.get('conditional_effects', [])) > 0

    def test_simple_moderation_no_variation(self):
        """Test that constant variables return error."""
        data = {
            'outcome_data': [1, 1, 1, 1, 1],
            'predictor_data': [1, 2, 3, 4, 5],
            'moderator_data': [1, 2, 3, 4, 5],
            'outcome_name': 'Y',
            'predictor_name': 'X',
            'moderator_name': 'W'
        }

        json_input = json.dumps(data)
        result = simple_moderation(json_input)
        parsed = json.loads(result)

        # Should fail or produce warnings due to no variation in Y
        assert 'error' in parsed or 'warnings' in parsed or parsed.get('success') == False


class TestModeratedMediationModel7:
    """Tests for Model 7: Moderated Mediation (W moderates X → M → Y)"""

    @pytest.fixture
    def sample_data(self):
        """Generate sample data for moderated mediation testing."""
        np.random.seed(42)
        n = 150

        # Generate data with moderated mediation
        x = np.random.normal(0, 1, n)
        w = np.random.normal(0, 1, n)
        # M = 0.5 + 0.3*X + 0.2*W + 0.4*X*W + error
        m = 0.5 + 0.3*x + 0.2*w + 0.4*x*w + np.random.normal(0, 0.5, n)
        # Y = 1 + 0.2*X + 0.4*M + error
        y = 1 + 0.2*x + 0.4*m + np.random.normal(0, 0.5, n)

        return {
            'outcome_data': y.tolist(),
            'predictor_data': x.tolist(),
            'mediator_data': m.tolist(),
            'moderator_data': w.tolist(),
            'outcome_name': 'Y',
            'predictor_name': 'X',
            'mediator_name': 'M',
            'moderator_name': 'W',
            'n_boot': 100,  # Reduced for testing speed
            'confidence': 0.95
        }

    def test_model7_returns_valid_json(self, sample_data):
        """Test that Model 7 returns valid JSON."""
        json_input = json.dumps(sample_data)
        result = moderated_mediation_model7(json_input)

        parsed = json.loads(result)
        assert 'success' in parsed
        assert parsed['success'] == True
        robust_meta = parsed.get('preprocessing', {}).get('robust_standard_errors', {})
        assert robust_meta.get('auto_selected') is True
        assert robust_meta.get('selected_type') in {'HC3', 'HC4', 'HC2'}
        assert parsed.get('apa_tables')

    def test_model7_contains_indirect_effects(self, sample_data):
        """Test that Model 7 contains indirect effects at different W values."""
        json_input = json.dumps(sample_data)
        result = moderated_mediation_model7(json_input)
        parsed = json.loads(result)

        assert parsed['success'] == True
        assert parsed['model_info']['controls'] == []
        assert 'conditional_indirect_effects' in parsed

        effects = parsed['conditional_indirect_effects']
        assert len(effects) >= 3

        for effect in effects:
            assert 'moderator_value' in effect
            assert 'moderator_value_centered' in effect
            assert 'effect' in effect
            assert 'boot_ci_lower' in effect
            assert 'boot_ci_upper' in effect
            assert 'ci_method' in effect

    def test_model7_contains_index_of_moderated_mediation(self, sample_data):
        """Test that Model 7 contains index of moderated mediation."""
        json_input = json.dumps(sample_data)
        result = moderated_mediation_model7(json_input)
        parsed = json.loads(result)

        assert parsed['success'] == True
        assert 'index_of_moderated_mediation' in parsed

        index = parsed['index_of_moderated_mediation']
        assert 'index' in index
        assert 'boot_ci_lower' in index
        assert 'boot_ci_upper' in index

    def test_model7_contains_direct_effect(self, sample_data):
        """Test that Model 7 contains direct effect of X on Y."""
        json_input = json.dumps(sample_data)
        result = moderated_mediation_model7(json_input)
        parsed = json.loads(result)

        assert parsed['success'] == True
        assert 'direct_effect' in parsed

        direct = parsed['direct_effect']
        assert 'effect' in direct
        assert 'statistic_type' in direct
        assert 'p' in direct or 'p_value' in direct

    def test_model7_contains_mediator_model(self, sample_data):
        """Test that Model 7 contains mediator model (M ~ X + W + X*W)."""
        json_input = json.dumps(sample_data)
        result = moderated_mediation_model7(json_input)
        parsed = json.loads(result)

        assert parsed['success'] == True
        assert 'outcome_models' in parsed
        assert 'M' in parsed['outcome_models']

    def test_model7_with_covariates(self, sample_data):
        """Test Model 7 with control variables."""
        np.random.seed(42)
        n = len(sample_data['outcome_data'])

        sample_data['control_data'] = [
            np.random.normal(0, 1, n).tolist()
        ]
        sample_data['control_names'] = ['C1']

        json_input = json.dumps(sample_data)
        result = moderated_mediation_model7(json_input)
        parsed = json.loads(result)

        assert parsed['success'] == True

    def test_model7_with_seed(self, sample_data):
        """Test that setting seed produces reproducible results."""
        sample_data['seed'] = 123

        json_input = json.dumps(sample_data)
        result1 = moderated_mediation_model7(json_input)
        result2 = moderated_mediation_model7(json_input)

        parsed1 = json.loads(result1)
        parsed2 = json.loads(result2)

        # Results should be identical with same seed
        assert parsed1['success'] == True
        assert parsed2['success'] == True

        # Check that indirect effects are the same
        effects1 = parsed1.get('conditional_indirect_effects', [])
        effects2 = parsed2.get('conditional_indirect_effects', [])

        if effects1 and effects2:
            assert abs(effects1[0]['effect'] - effects2[0]['effect']) < 0.0001

    def test_model7_custom_confidence_level(self, sample_data):
        """Test Model 7 with custom confidence level."""
        sample_data['confidence'] = 0.90

        json_input = json.dumps(sample_data)
        result = moderated_mediation_model7(json_input)
        parsed = json.loads(result)

        assert parsed['success'] == True

        # Confidence intervals should be narrower than 95%
        if 'index_of_moderated_mediation' in parsed:
            index = parsed['index_of_moderated_mediation']
            # 90% CI should be stored or reflected in the results
            assert 'boot_ci_lower' in index
            assert 'boot_ci_upper' in index

    def test_model7_binary_outcome_uses_logistic(self, sample_data):
        """Binary outcomes should trigger logistic metadata."""
        y = np.array(sample_data['outcome_data'])
        sample_data['outcome_data'] = (y > np.median(y)).astype(int).tolist()
        sample_data['categorical_encodings'] = {'Y': {'Low': 0, 'High': 1}}

        json_input = json.dumps(sample_data)
        result = moderated_mediation_model7(json_input)
        parsed = json.loads(result)

        assert parsed['success'] == True
        preprocessing = parsed.get('preprocessing', {})
        logistic_info = preprocessing.get('logistic', {})
        assert logistic_info.get('attempted') is True
        assert logistic_info.get('used') is True

    def test_model7_reports_total_and_pairwise(self, sample_data):
        """New outputs should include total indirect and pairwise contrasts."""
        json_input = json.dumps(sample_data)
        parsed = json.loads(moderated_mediation_model7(json_input))

        assert parsed['success'] is True
        assert 'total_indirect_effect' in parsed
        assert 'pairwise_contrasts' in parsed
        assert len(parsed['pairwise_contrasts']) >= 3
        assert 'apa_tables' in parsed

    def test_model7_with_robust_se(self, sample_data):
        """Robust SE option should mark metadata and APA tables."""
        sample_data['robust_se'] = 'HC4'
        json_input = json.dumps(sample_data)
        parsed = json.loads(moderated_mediation_model7(json_input))

        robust_meta = parsed.get('preprocessing', {}).get('robust_standard_errors', {})
        assert robust_meta.get('requested') == 'HC4'
        assert robust_meta.get('selected_type') == 'HC4'
        assert parsed.get('apa_tables')


class TestEdgeCases:
    """Test edge cases and error handling."""

    def test_invalid_json_input(self):
        """Test handling of invalid JSON input."""
        result = simple_moderation("not valid json")
        parsed = json.loads(result)

        assert parsed['success'] == False
        assert 'error' in parsed

    def test_missing_required_fields(self):
        """Test handling of missing required fields."""
        data = {
            'outcome_data': [1, 2, 3, 4, 5],
            'predictor_data': [1, 2, 3, 4, 5]
            # Missing moderator_data
        }

        json_input = json.dumps(data)
        result = simple_moderation(json_input)
        parsed = json.loads(result)

        assert parsed['success'] == False
        assert 'error' in parsed

    def test_mismatched_array_lengths(self):
        """Test handling of mismatched array lengths."""
        data = {
            'outcome_data': [1, 2, 3, 4, 5],
            'predictor_data': [1, 2, 3],  # Different length
            'moderator_data': [1, 2, 3, 4, 5],
            'outcome_name': 'Y',
            'predictor_name': 'X',
            'moderator_name': 'W'
        }

        json_input = json.dumps(data)
        result = simple_moderation(json_input)
        parsed = json.loads(result)

        assert parsed['success'] == False
        assert 'error' in parsed

    def test_empty_arrays(self):
        """Test handling of empty arrays."""
        data = {
            'outcome_data': [],
            'predictor_data': [],
            'moderator_data': [],
            'outcome_name': 'Y',
            'predictor_name': 'X',
            'moderator_name': 'W'
        }

        json_input = json.dumps(data)
        result = simple_moderation(json_input)
        parsed = json.loads(result)

        assert parsed['success'] == False
        assert 'error' in parsed


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
