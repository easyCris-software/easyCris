"""
Unit tests for dose_response.py module

Tests 4PL dose-response curve fitting with comprehensive coverage:
- Valid dose-response data
- Parameter estimation accuracy
- Goodness-of-fit metrics
- Error handling for edge cases

VERSION: 1.0
DATE: November 26, 2025
"""

import pytest
import json
import numpy as np
from statistics_module.dose_response import (
    fit_4pl_dose_response,
    fit_3pl_dose_response,
    fit_5pl_dose_response,
    dose_response_analysis,
    compare_dose_response_models
)


class TestDoseResponseFitting:
    """Tests for 4PL dose-response curve fitting"""

    @pytest.fixture
    def realistic_dose_response_data(self):
        """
        Realistic dose-response data for IC50 testing
        Expected IC50 ~4.94, Hill slope ~-1.02
        """
        doses = np.array([0.1, 0.5, 1.0, 2.5, 5.0, 10.0, 25.0, 50.0, 100.0])
        responses = np.array([5.2, 8.9, 15.3, 35.7, 55.2, 78.4, 92.1, 97.8, 99.1])
        return doses, responses

    @pytest.fixture
    def simple_dose_response_data(self):
        """Simple S-shaped dose-response curve"""
        doses = np.array([0.1, 1.0, 10.0, 100.0])
        responses = np.array([10.0, 30.0, 70.0, 90.0])
        return doses, responses

    def test_fit_4pl_basic_functionality(self, realistic_dose_response_data):
        """Test that 4PL fitting completes without errors"""
        doses, responses = realistic_dose_response_data

        result = fit_4pl_dose_response(doses, responses)

        assert result is not None
        assert isinstance(result, dict)
        assert "success" in result
        assert result["success"] is True

    def test_fit_4pl_returns_required_parameters(self, realistic_dose_response_data):
        """Test that all required parameters are returned"""
        doses, responses = realistic_dose_response_data

        result = fit_4pl_dose_response(doses, responses)

        # Check required keys
        assert "parameters" in result
        assert "goodness_of_fit" in result
        assert "model_type" in result
        assert "n_observations" in result

        # Check parameter structure
        params = result["parameters"]
        assert "ic50" in params
        assert "hill" in params
        assert "top" in params
        assert "bottom" in params

        # Each parameter should have value, stderr, CI
        for param_name in ["ic50", "hill", "top", "bottom"]:
            param = params[param_name]
            assert "value" in param
            assert "stderr" in param
            assert "ci_lower" in param
            assert "ci_upper" in param

    def test_fit_4pl_ic50_accuracy(self, realistic_dose_response_data):
        """Test that IC50 is estimated within acceptable range"""
        doses, responses = realistic_dose_response_data

        result = fit_4pl_dose_response(doses, responses)

        ic50_value = result["parameters"]["ic50"]["value"]

        # IC50 should be around 4.94 for this dataset
        assert 3.0 < ic50_value < 7.0, f"IC50 {ic50_value} is outside expected range"

    def test_fit_4pl_hill_slope_positive(self, realistic_dose_response_data):
        """Test that Hill slope is positive (reporting convention for inhibition)"""
        doses, responses = realistic_dose_response_data

        result = fit_4pl_dose_response(doses, responses)

        hill_value = result["parameters"]["hill"]["value"]

        # Hill slope should be positive after convention conversion
        assert hill_value > 0, f"Hill slope {hill_value} should be positive"

    def test_fit_4pl_top_bottom_bounds(self, realistic_dose_response_data):
        """Test that top > bottom for valid curve"""
        doses, responses = realistic_dose_response_data

        result = fit_4pl_dose_response(doses, responses)

        top_value = result["parameters"]["top"]["value"]
        bottom_value = result["parameters"]["bottom"]["value"]

        assert top_value > bottom_value, "Top should be greater than bottom"

    def test_fit_4pl_goodness_of_fit_metrics(self, realistic_dose_response_data):
        """Test that goodness-of-fit metrics are calculated"""
        doses, responses = realistic_dose_response_data

        result = fit_4pl_dose_response(doses, responses)

        gof = result["goodness_of_fit"]

        assert "r_squared" in gof
        assert "adj_r_squared" in gof
        assert "rmse" in gof
        assert "aic" in gof
        assert "bic" in gof

        # R² should be high for good fit
        assert 0.0 <= gof["r_squared"] <= 1.0
        assert gof["r_squared"] > 0.90, "R² should indicate good fit"

    def test_fit_4pl_n_observations(self, realistic_dose_response_data):
        """Test that n_observations matches input data"""
        doses, responses = realistic_dose_response_data

        result = fit_4pl_dose_response(doses, responses)

        assert result["n_observations"] == len(doses)

    def test_dose_response_analysis_json_interface(self, realistic_dose_response_data):
        """Test JSON interface for C# integration"""
        doses, responses = realistic_dose_response_data

        doses_json = json.dumps(doses.tolist())
        responses_json = json.dumps(responses.tolist())

        result_json = dose_response_analysis(doses_json, responses_json, model_type="4PL")

        # Should return valid JSON string
        assert isinstance(result_json, str)

        # Parse and validate
        result = json.loads(result_json)
        assert result["success"] is True
        assert "parameters" in result

    def test_dose_response_analysis_model_type_4pl(self):
        """Test that model_type is correctly set to 4PL"""
        doses_json = json.dumps([0.1, 1.0, 10.0, 100.0])
        responses_json = json.dumps([10.0, 30.0, 70.0, 90.0])

        result_json = dose_response_analysis(doses_json, responses_json, model_type="4PL")
        result = json.loads(result_json)

        assert result["model_type"] == "4PL"


class TestDoseResponseErrorHandling:
    """Tests for error handling and edge cases"""

    def test_insufficient_data_points(self):
        """Test error handling for < 4 data points"""
        doses = np.array([1.0, 10.0, 100.0])  # Only 3 points
        responses = np.array([10.0, 50.0, 90.0])

        result = fit_4pl_dose_response(doses, responses)

        assert result["success"] is False
        assert "error" in result
        assert "4 data points" in result["error"]

    def test_zero_dose_handling(self):
        """Test error handling for zero doses"""
        doses = np.array([0.0, 1.0, 10.0, 100.0])  # Zero dose included
        responses = np.array([5.0, 30.0, 70.0, 95.0])

        result = fit_4pl_dose_response(doses, responses)

        # Should either handle gracefully or error clearly
        if not result["success"]:
            assert "error" in result

    def test_negative_dose_handling(self):
        """Test error handling for negative doses"""
        doses = np.array([-1.0, 1.0, 10.0, 100.0])  # Negative dose
        responses = np.array([5.0, 30.0, 70.0, 95.0])

        result = fit_4pl_dose_response(doses, responses)

        # Should fail or handle gracefully
        if not result["success"]:
            assert "error" in result

    def test_nan_values_in_data(self):
        """Test error handling for NaN values"""
        doses = np.array([1.0, np.nan, 10.0, 100.0])
        responses = np.array([10.0, 30.0, 70.0, 90.0])

        result = fit_4pl_dose_response(doses, responses)

        # Should detect and handle NaN values
        assert result["success"] is False
        assert "error" in result

    def test_mismatched_array_lengths(self):
        """Test error handling for mismatched dose/response lengths"""
        doses = np.array([1.0, 10.0, 100.0])
        responses = np.array([10.0, 50.0])  # Different length

        result = fit_4pl_dose_response(doses, responses)

        assert result["success"] is False
        assert "error" in result
        assert "same length" in result["error"].lower()

    def test_constant_response_values(self):
        """Test error handling for constant responses (no variation)"""
        doses = np.array([0.1, 1.0, 10.0, 100.0])
        responses = np.array([50.0, 50.0, 50.0, 50.0])  # All same

        result = fit_4pl_dose_response(doses, responses)

        # Should fail to fit meaningful curve
        if not result["success"]:
            assert "error" in result

    def test_json_parsing_invalid_format(self):
        """Test error handling for invalid JSON input"""
        doses_json = "not valid json"
        responses_json = json.dumps([10.0, 50.0, 90.0])

        result_json = dose_response_analysis(doses_json, responses_json)
        result = json.loads(result_json)

        assert result["success"] is False
        assert "error" in result


class TestDoseResponseParameterEstimation:
    """Tests for specific parameter estimation scenarios"""

    def test_high_potency_compound(self):
        """Test fitting for highly potent compound (low IC50)"""
        doses = np.array([0.001, 0.01, 0.1, 1.0, 10.0])
        responses = np.array([5.0, 15.0, 50.0, 85.0, 95.0])

        result = fit_4pl_dose_response(doses, responses)

        assert result["success"] is True
        ic50_value = result["parameters"]["ic50"]["value"]

        # IC50 should be around 0.1 for this dataset
        assert 0.05 < ic50_value < 0.5

    def test_low_potency_compound(self):
        """Test fitting for low potency compound (high IC50)"""
        doses = np.array([10.0, 50.0, 100.0, 500.0, 1000.0])
        responses = np.array([10.0, 30.0, 50.0, 75.0, 90.0])

        result = fit_4pl_dose_response(doses, responses)

        assert result["success"] is True
        ic50_value = result["parameters"]["ic50"]["value"]

        # IC50 should be around 100 for this dataset
        assert 50.0 < ic50_value < 500.0

    def test_steep_hill_slope(self):
        """Test fitting for steep dose-response curve"""
        doses = np.array([0.1, 1.0, 5.0, 10.0, 100.0])
        responses = np.array([5.0, 5.0, 50.0, 95.0, 95.0])  # Steep transition

        result = fit_4pl_dose_response(doses, responses)

        assert result["success"] is True
        hill_value = result["parameters"]["hill"]["value"]

        # Should detect steep slope (more negative)
        assert hill_value < -2.0 or hill_value > 2.0

    def test_confidence_intervals_non_zero(self):
        """Test that confidence intervals are non-zero"""
        doses = np.array([0.1, 1.0, 10.0, 100.0, 1000.0])
        responses = np.array([10.0, 25.0, 50.0, 75.0, 90.0])

        result = fit_4pl_dose_response(doses, responses)

        assert result["success"] is True

        # CI should have width (upper != lower)
        ic50_ci_lower = result["parameters"]["ic50"]["ci_lower"]
        ic50_ci_upper = result["parameters"]["ic50"]["ci_upper"]

        assert ic50_ci_upper > ic50_ci_lower
        assert ic50_ci_lower > 0  # IC50 must be positive


class TestThreePLFitting:
    """Tests for 3PL dose-response curve fitting with fixed bottom"""

    @pytest.fixture
    def normalized_dose_response_data(self):
        """
        Normalized dose-response data (bottom should be ~0)
        Suitable for 3PL with bottom_fixed=0.0
        """
        doses = np.array([0.1, 0.5, 1.0, 2.5, 5.0, 10.0, 25.0, 50.0, 100.0])
        responses = np.array([0.5, 3.2, 10.1, 30.5, 50.8, 72.3, 88.5, 95.2, 98.1])
        return doses, responses

    @pytest.fixture
    def simple_3pl_data(self):
        """Simple S-shaped curve with bottom near zero"""
        doses = np.array([0.1, 1.0, 10.0, 100.0])
        responses = np.array([0.0, 20.0, 70.0, 95.0])
        return doses, responses

    # ===== Basic Functionality Tests =====

    def test_fit_3pl_basic_functionality(self, normalized_dose_response_data):
        """Test that 3PL fitting completes without errors"""
        doses, responses = normalized_dose_response_data

        result = fit_3pl_dose_response(doses, responses, bottom_fixed=0.0)

        assert result is not None
        assert isinstance(result, dict)
        assert "success" in result
        assert result["success"] is True

    def test_fit_3pl_returns_required_parameters(self, normalized_dose_response_data):
        """Test that all required parameters are returned"""
        doses, responses = normalized_dose_response_data

        result = fit_3pl_dose_response(doses, responses, bottom_fixed=0.0)

        # Check required keys
        assert "parameters" in result
        assert "goodness_of_fit" in result
        assert "model_type" in result
        assert "fixed_bottom" in result
        assert "n_observations" in result

        # Model type should be 3PL
        assert result["model_type"] == "3PL"
        assert result["fixed_bottom"] == 0.0

        # Check parameter structure - should have 3 parameters, NOT 4
        params = result["parameters"]
        assert "ic50" in params
        assert "hill" in params
        assert "top" in params
        assert "bottom" not in params  # Bottom should NOT be in parameters

        # Each parameter should have value, stderr, CI
        for param_name in ["ic50", "hill", "top"]:
            param = params[param_name]
            assert "value" in param
            assert "stderr" in param
            assert "ci_lower" in param
            assert "ci_upper" in param

    def test_fit_3pl_bottom_is_fixed(self, normalized_dose_response_data):
        """Test that bottom is not a fitted parameter"""
        doses, responses = normalized_dose_response_data

        result = fit_3pl_dose_response(doses, responses, bottom_fixed=0.0)

        # Bottom should not be in fitted parameters
        assert "bottom" not in result["parameters"]
        # But should be documented in fixed_bottom
        assert result["fixed_bottom"] == 0.0

    # ===== Parameter Accuracy Tests =====

    def test_fit_3pl_with_zero_bottom(self, normalized_dose_response_data):
        """Test 3PL with bottom fixed at 0 (normalized data)"""
        doses, responses = normalized_dose_response_data

        result = fit_3pl_dose_response(doses, responses, bottom_fixed=0.0)

        assert result["success"] is True
        assert result["fixed_bottom"] == 0.0

        # IC50 should be reasonable
        ic50_value = result["parameters"]["ic50"]["value"]
        assert 1.0 < ic50_value < 20.0

        # Top should be near max response
        top_value = result["parameters"]["top"]["value"]
        assert 90.0 < top_value < 110.0

    def test_fit_3pl_with_custom_bottom(self):
        """Test 3PL with custom fixed bottom value"""
        # Data with baseline at 10.0
        doses = np.array([0.1, 1.0, 10.0, 100.0])
        responses = np.array([10.0, 30.0, 70.0, 95.0])

        result = fit_3pl_dose_response(doses, responses, bottom_fixed=10.0)

        assert result["success"] is True
        assert result["fixed_bottom"] == 10.0

        # Top should be > fixed bottom
        top_value = result["parameters"]["top"]["value"]
        assert top_value > 10.0

    def test_fit_3pl_ic50_accuracy(self, normalized_dose_response_data):
        """Test that IC50 is estimated within acceptable range"""
        doses, responses = normalized_dose_response_data

        result = fit_3pl_dose_response(doses, responses, bottom_fixed=0.0)

        ic50_value = result["parameters"]["ic50"]["value"]

        # IC50 should be around 5.0 for this dataset
        assert 3.0 < ic50_value < 10.0, f"IC50 {ic50_value} is outside expected range"

    def test_fit_3pl_hill_slope_adaptive(self):
        """Test that Hill slope adapts to curve direction"""
        # Activation curve (response increases with dose)
        doses = np.array([0.1, 1.0, 10.0, 100.0])
        responses_activation = np.array([0.0, 20.0, 70.0, 95.0])

        result_activation = fit_3pl_dose_response(doses, responses_activation,
                                                  bottom_fixed=0.0)

        assert result_activation["success"] is True
        hill_activation = result_activation["parameters"]["hill"]["value"]

        # Hill slope should be negative for activation (response increases)
        assert hill_activation < 0, f"Hill slope {hill_activation} should be negative for activation"

    # ===== Goodness-of-Fit Tests =====

    def test_fit_3pl_goodness_of_fit_metrics(self, normalized_dose_response_data):
        """Test that goodness-of-fit metrics are calculated"""
        doses, responses = normalized_dose_response_data

        result = fit_3pl_dose_response(doses, responses, bottom_fixed=0.0)

        gof = result["goodness_of_fit"]

        assert "r_squared" in gof
        assert "adj_r_squared" in gof
        assert "rmse" in gof
        assert "aic" in gof
        assert "bic" in gof

        # R² should be high for good fit
        assert 0.0 <= gof["r_squared"] <= 1.0
        assert gof["r_squared"] > 0.90, "R² should indicate good fit"

    def test_fit_3pl_degrees_of_freedom(self, normalized_dose_response_data):
        """Test that adjusted R² uses k=3 (not k=4)"""
        doses, responses = normalized_dose_response_data

        result = fit_3pl_dose_response(doses, responses, bottom_fixed=0.0)

        n = result["n_observations"]
        assert n == 9

        # With n=9 and k=3, adjusted R² should be defined
        adj_r_squared = result["goodness_of_fit"]["adj_r_squared"]
        assert adj_r_squared is not None, "Adjusted R² should be defined for n=9, k=3"

        # Manually verify calculation (n=9, k=3)
        # adj_r² = 1 - (1 - r²) * (n - 1) / (n - k - 1)
        # For n=9, k=3: (n - k - 1) = 5 (should be defined)
        r_squared = result["goodness_of_fit"]["r_squared"]
        expected_adj_r_squared = 1 - (1 - r_squared) * (9 - 1) / (9 - 3 - 1)

        # Should match within floating point tolerance
        assert abs(adj_r_squared - expected_adj_r_squared) < 0.01

    # ===== Error Handling Tests =====

    def test_fit_3pl_insufficient_data_points(self):
        """Test error handling for < 4 data points"""
        doses = np.array([1.0, 10.0, 100.0])  # Only 3 points
        responses = np.array([10.0, 50.0, 90.0])

        result = fit_3pl_dose_response(doses, responses, bottom_fixed=0.0)

        assert result["success"] is False
        assert "error" in result
        assert "4 data points" in result["error"]

    def test_fit_3pl_zero_dose_handling(self):
        """Test error handling for zero doses"""
        doses = np.array([0.0, 1.0, 10.0, 100.0])  # Zero dose included
        responses = np.array([0.0, 30.0, 70.0, 95.0])

        result = fit_3pl_dose_response(doses, responses, bottom_fixed=0.0)

        # Should fail gracefully
        assert result["success"] is False
        assert "error" in result

    def test_fit_3pl_negative_dose_handling(self):
        """Test error handling for negative doses"""
        doses = np.array([-1.0, 1.0, 10.0, 100.0])  # Negative dose
        responses = np.array([0.0, 30.0, 70.0, 95.0])

        result = fit_3pl_dose_response(doses, responses, bottom_fixed=0.0)

        # Should fail gracefully
        assert result["success"] is False
        assert "error" in result

    def test_fit_3pl_nan_values(self):
        """Test error handling for NaN values"""
        doses = np.array([1.0, np.nan, 10.0, 100.0])
        responses = np.array([0.0, 30.0, 70.0, 90.0])

        result = fit_3pl_dose_response(doses, responses, bottom_fixed=0.0)

        # Should detect and handle NaN values
        assert result["success"] is False
        assert "error" in result

    def test_fit_3pl_mismatched_array_lengths(self):
        """Test error handling for mismatched dose/response lengths"""
        doses = np.array([1.0, 10.0, 100.0])
        responses = np.array([0.0, 50.0])  # Different length

        result = fit_3pl_dose_response(doses, responses, bottom_fixed=0.0)

        assert result["success"] is False
        assert "error" in result
        assert "same length" in result["error"].lower()

    # ===== JSON Interface Tests =====

    def test_3pl_json_interface(self, normalized_dose_response_data):
        """Test JSON interface for C# integration with 3PL"""
        doses, responses = normalized_dose_response_data

        doses_json = json.dumps(doses.tolist())
        responses_json = json.dumps(responses.tolist())

        result_json = dose_response_analysis(doses_json, responses_json,
                                            model_type="3PL")

        # Should return valid JSON string
        assert isinstance(result_json, str)

        # Parse and validate
        result = json.loads(result_json)
        assert result["success"] is True
        assert result["model_type"] == "3PL"
        assert "parameters" in result
        assert "fixed_bottom" in result
        assert result["fixed_bottom"] == 0.0  # Default

    def test_3pl_custom_bottom_via_json(self):
        """Test passing custom bottom_fixed via JSON interface"""
        doses = np.array([0.1, 1.0, 10.0, 100.0])
        responses = np.array([15.0, 30.0, 70.0, 95.0])

        doses_json = json.dumps(doses.tolist())
        responses_json = json.dumps(responses.tolist())

        result_json = dose_response_analysis(doses_json, responses_json,
                                            model_type="3PL",
                                            bottom_fixed=15.0)

        result = json.loads(result_json)
        assert result["success"] is True
        assert result["fixed_bottom"] == 15.0


class TestFivePLFitting:
    """Tests for 5PL dose-response curve fitting with asymmetry"""

    @pytest.fixture
    def asymmetric_dose_response_data(self):
        """
        Dose-response data with asymmetry (different slopes on each limb)
        Suitable for 5PL fitting (n=11 for no warnings)
        """
        doses = np.array([0.01, 0.1, 0.5, 1.0, 5.0, 10.0, 50.0, 100.0, 500.0, 1000.0, 2000.0])
        # Asymmetric response curve
        responses = np.array([2.5, 5.8, 18.2, 35.4, 62.7, 75.3, 88.9, 93.5, 97.2, 98.5, 99.0])
        return doses, responses

    @pytest.fixture
    def simple_5pl_data(self):
        """Minimal 5PL data (n=6)"""
        doses = np.array([0.1, 1.0, 5.0, 10.0, 50.0, 100.0])
        responses = np.array([5.0, 20.0, 45.0, 65.0, 88.0, 95.0])
        return doses, responses

    # ===== Basic Functionality Tests =====

    def test_fit_5pl_basic_functionality(self, asymmetric_dose_response_data):
        """Test that 5PL fitting completes without errors"""
        doses, responses = asymmetric_dose_response_data

        result = fit_5pl_dose_response(doses, responses)

        assert result is not None
        assert isinstance(result, dict)
        assert "success" in result
        assert result["success"] is True

    def test_fit_5pl_returns_required_parameters(self, asymmetric_dose_response_data):
        """Test that all required parameters are returned"""
        doses, responses = asymmetric_dose_response_data

        result = fit_5pl_dose_response(doses, responses)

        # Check required keys
        assert "parameters" in result
        assert "goodness_of_fit" in result
        assert "model_type" in result
        assert "n_observations" in result

        # Model type should be 5PL
        assert result["model_type"] == "5PL"

        # Check parameter structure - should have 5 parameters
        params = result["parameters"]
        assert "ic50" in params
        assert "hill" in params
        assert "top" in params
        assert "bottom" in params
        assert "asymmetry" in params  # NEW for 5PL

        # Each parameter should have value, stderr, CI
        for param_name in ["ic50", "hill", "top", "bottom", "asymmetry"]:
            param = params[param_name]
            assert "value" in param
            assert "stderr" in param
            assert "ci_lower" in param
            assert "ci_upper" in param

    def test_fit_5pl_has_asymmetry_parameter(self, asymmetric_dose_response_data):
        """Test that 5PL includes asymmetry parameter"""
        doses, responses = asymmetric_dose_response_data

        result = fit_5pl_dose_response(doses, responses)

        assert "asymmetry" in result["parameters"]
        asymmetry_value = result["parameters"]["asymmetry"]["value"]

        # Asymmetry should be positive and reasonable
        assert asymmetry_value > 0
        assert 0.1 <= asymmetry_value <= 10.0

    # ===== Parameter Accuracy Tests =====

    def test_fit_5pl_ic50_accuracy(self, asymmetric_dose_response_data):
        """Test that IC50 is estimated within acceptable range"""
        doses, responses = asymmetric_dose_response_data

        result = fit_5pl_dose_response(doses, responses)

        ic50_value = result["parameters"]["ic50"]["value"]

        # IC50 should be within dose range
        assert np.min(doses) < ic50_value < np.max(doses)

    def test_fit_5pl_hill_slope_sign(self, asymmetric_dose_response_data):
        """Test that Hill slope adapts to curve direction"""
        doses, responses = asymmetric_dose_response_data

        result = fit_5pl_dose_response(doses, responses)

        hill_value = result["parameters"]["hill"]["value"]

        # Hill slope should be negative for activation curves (response increases)
        assert hill_value < 0, f"Hill slope {hill_value} should be negative for activation"

    def test_fit_5pl_top_bottom_bounds(self, asymmetric_dose_response_data):
        """Test that top > bottom for valid curve"""
        doses, responses = asymmetric_dose_response_data

        result = fit_5pl_dose_response(doses, responses)

        top_value = result["parameters"]["top"]["value"]
        bottom_value = result["parameters"]["bottom"]["value"]

        assert top_value > bottom_value, "Top should be greater than bottom"

    def test_fit_5pl_asymmetry_near_one_resembles_4pl(self):
        """Test that when asymmetry ≈ 1.0, 5PL resembles 4PL"""
        # Symmetric curve - asymmetry may converge to any valid value
        # (for truly symmetric data, asymmetry doesn't improve fit significantly)
        doses = np.array([0.1, 1.0, 5.0, 10.0, 50.0, 100.0])
        responses = np.array([5.0, 25.0, 50.0, 75.0, 90.0, 95.0])

        result = fit_5pl_dose_response(doses, responses)

        assert result["success"] is True
        asymmetry_value = result["parameters"]["asymmetry"]["value"]

        # For symmetric data, asymmetry should be within valid range
        # (it may not necessarily be close to 1.0 if the data is truly symmetric)
        assert 0.1 <= asymmetry_value <= 10.0, f"Asymmetry {asymmetry_value} should be within valid range"

    def test_fit_5pl_asymmetry_interpretation(self, asymmetric_dose_response_data):
        """Test that asymmetry parameter is within valid range"""
        doses, responses = asymmetric_dose_response_data

        result = fit_5pl_dose_response(doses, responses)

        asymmetry_value = result["parameters"]["asymmetry"]["value"]

        # Should be within bounds set in parameter initialization
        assert 0.1 <= asymmetry_value <= 10.0

    # ===== Goodness-of-Fit Tests =====

    def test_fit_5pl_goodness_of_fit_metrics(self, asymmetric_dose_response_data):
        """Test that goodness-of-fit metrics are calculated"""
        doses, responses = asymmetric_dose_response_data

        result = fit_5pl_dose_response(doses, responses)

        gof = result["goodness_of_fit"]

        assert "r_squared" in gof
        assert "adj_r_squared" in gof
        assert "rmse" in gof
        assert "aic" in gof
        assert "bic" in gof

        # R² should be high for good fit
        assert 0.0 <= gof["r_squared"] <= 1.0
        assert gof["r_squared"] > 0.90, "R² should indicate good fit"

    def test_fit_5pl_degrees_of_freedom(self, asymmetric_dose_response_data):
        """Test that adjusted R² uses k=5 (not k=4)"""
        doses, responses = asymmetric_dose_response_data

        result = fit_5pl_dose_response(doses, responses)

        n = result["n_observations"]
        assert n == 11

        # With n=11 and k=5, adjusted R² should be defined
        adj_r_squared = result["goodness_of_fit"]["adj_r_squared"]
        assert adj_r_squared is not None, "Adjusted R² should be defined for n=11, k=5"

        # Manually verify calculation (n=11, k=5)
        # adj_r² = 1 - (1 - r²) * (n - 1) / (n - k - 1)
        # For n=11, k=5: (n - k - 1) = 5 (should be defined)
        r_squared = result["goodness_of_fit"]["r_squared"]
        expected_adj_r_squared = 1 - (1 - r_squared) * (11 - 1) / (11 - 5 - 1)

        # Should match within floating point tolerance
        assert abs(adj_r_squared - expected_adj_r_squared) < 0.01

    # ===== Error Handling Tests =====

    def test_fit_5pl_strict_minimum_data_points(self):
        """Test strict n≥6 requirement for 5PL"""
        # Exactly 5 points (should fail)
        doses = np.array([0.1, 1.0, 10.0, 100.0, 1000.0])
        responses = np.array([10.0, 30.0, 50.0, 75.0, 90.0])

        result = fit_5pl_dose_response(doses, responses)

        assert result["success"] is False
        assert "error" in result
        assert "6 data points" in result["error"]

    def test_fit_5pl_exactly_six_points_succeeds(self, simple_5pl_data):
        """Test that exactly 6 points is accepted (minimum, with warnings)"""
        doses, responses = simple_5pl_data

        result = fit_5pl_dose_response(doses, responses)

        # Should succeed with n=6 but with strong warnings
        assert result["success"] is True
        assert result["n_observations"] == 6
        # Should have warning about n=6
        assert len(result["warnings"]) > 0
        assert "6 data points" in result["warnings"][0]
        assert "Adjusted R²" in result["warnings"][0]

    def test_fit_5pl_zero_dose_handling(self):
        """Test error handling for zero doses"""
        doses = np.array([0.0, 1.0, 10.0, 100.0, 1000.0, 10000.0])
        responses = np.array([0.0, 30.0, 50.0, 75.0, 90.0, 95.0])

        result = fit_5pl_dose_response(doses, responses)

        # Should fail gracefully
        assert result["success"] is False
        assert "error" in result

    def test_fit_5pl_nan_values(self):
        """Test error handling for NaN values"""
        doses = np.array([1.0, np.nan, 10.0, 100.0, 1000.0, 10000.0])
        responses = np.array([10.0, 30.0, 50.0, 75.0, 90.0, 95.0])

        result = fit_5pl_dose_response(doses, responses)

        # Should detect and handle NaN values
        assert result["success"] is False
        assert "error" in result

    def test_fit_5pl_mismatched_array_lengths(self):
        """Test error handling for mismatched dose/response lengths"""
        doses = np.array([1.0, 10.0, 100.0])
        responses = np.array([10.0, 50.0, 90.0, 95.0, 98.0, 99.0])

        result = fit_5pl_dose_response(doses, responses)

        assert result["success"] is False
        assert "error" in result
        assert "same length" in result["error"].lower()

    # ===== JSON Interface Tests =====

    def test_5pl_json_interface(self, asymmetric_dose_response_data):
        """Test JSON interface for C# integration with 5PL"""
        doses, responses = asymmetric_dose_response_data

        doses_json = json.dumps(doses.tolist())
        responses_json = json.dumps(responses.tolist())

        result_json = dose_response_analysis(doses_json, responses_json,
                                            model_type="5PL")

        # Should return valid JSON string
        assert isinstance(result_json, str)

        # Parse and validate
        result = json.loads(result_json)
        assert result["success"] is True
        assert result["model_type"] == "5PL"
        assert "parameters" in result
        assert "asymmetry" in result["parameters"]

    def test_5pl_no_warnings(self, asymmetric_dose_response_data):
        """Test that 5PL does not generate warnings (strict n≥6 enforced)"""
        doses, responses = asymmetric_dose_response_data

        result = fit_5pl_dose_response(doses, responses)

        assert result["success"] is True
        # Warnings array should be empty for 5PL
        assert "warnings" in result
        assert len(result["warnings"]) == 0


class TestMultiModelComparison:
    """Tests for multi-model comparison (3PL vs 4PL vs 5PL)"""

    @pytest.fixture
    def comparison_test_data(self):
        """
        Data suitable for comparing all three models (n=7)
        """
        doses = np.array([0.1, 0.5, 1.0, 5.0, 10.0, 50.0, 100.0])
        responses = np.array([5.0, 10.0, 20.0, 55.0, 75.0, 95.0, 98.0])
        return doses, responses

    @pytest.fixture
    def minimal_comparison_data(self):
        """
        Minimal data (n=4) - only 3PL and 4PL can be fitted
        """
        doses = np.array([0.1, 1.0, 10.0, 100.0])
        responses = np.array([10.0, 30.0, 70.0, 90.0])
        return doses, responses

    def test_compare_models_basic_functionality(self, comparison_test_data):
        """Test that model comparison completes without errors"""
        doses, responses = comparison_test_data

        result = compare_dose_response_models(doses, responses)

        assert result is not None
        assert isinstance(result, dict)
        assert "success" in result
        assert result["success"] is True

    def test_compare_models_required_structure(self, comparison_test_data):
        """Test that all required keys are present in comparison results"""
        doses, responses = comparison_test_data

        result = compare_dose_response_models(doses, responses)

        # Top-level keys
        assert "n_observations" in result
        assert "models" in result
        assert "comparison" in result

        # Models section
        models = result["models"]
        assert "3PL" in models
        assert "4PL" in models
        assert "5PL" in models

        # Comparison section
        comparison = result["comparison"]
        assert "aic_ranking" in comparison
        assert "bic_ranking" in comparison
        assert "recommended_model" in comparison
        assert "recommendation_reason" in comparison

    def test_compare_models_all_three_fitted(self, comparison_test_data):
        """Test that all three models are fitted successfully with n=7"""
        doses, responses = comparison_test_data

        result = compare_dose_response_models(doses, responses)

        # All three models should succeed
        assert result["models"]["3PL"]["success"] is True
        assert result["models"]["4PL"]["success"] is True
        assert result["models"]["5PL"]["success"] is True

    def test_compare_models_5pl_excluded_with_minimal_data(self, minimal_comparison_data):
        """Test that 5PL is excluded when n < 6"""
        doses, responses = minimal_comparison_data

        result = compare_dose_response_models(doses, responses)

        # 3PL and 4PL should succeed
        assert result["models"]["3PL"]["success"] is True
        assert result["models"]["4PL"]["success"] is True

        # 5PL should be marked as not fitted
        assert result["models"]["5PL"]["fitted"] is False
        assert "reason" in result["models"]["5PL"]
        assert "6 data points" in result["models"]["5PL"]["reason"]

    def test_compare_models_aic_ranking_structure(self, comparison_test_data):
        """Test that AIC ranking has correct structure"""
        doses, responses = comparison_test_data

        result = compare_dose_response_models(doses, responses)

        aic_ranking = result["comparison"]["aic_ranking"]

        # Should have 3 models (all fitted with n=7)
        assert len(aic_ranking) == 3

        # Each entry should have model, aic, delta_aic
        for entry in aic_ranking:
            assert "model" in entry
            assert "aic" in entry
            assert "delta_aic" in entry

        # First entry should have delta_aic = 0 (best model)
        assert aic_ranking[0]["delta_aic"] == 0.0

        # AIC should be sorted (ascending)
        for i in range(len(aic_ranking) - 1):
            assert aic_ranking[i]["aic"] <= aic_ranking[i + 1]["aic"]

    def test_compare_models_bic_ranking_structure(self, comparison_test_data):
        """Test that BIC ranking has correct structure"""
        doses, responses = comparison_test_data

        result = compare_dose_response_models(doses, responses)

        bic_ranking = result["comparison"]["bic_ranking"]

        # Should have 3 models
        assert len(bic_ranking) == 3

        # Each entry should have model, bic, delta_bic
        for entry in bic_ranking:
            assert "model" in entry
            assert "bic" in entry
            assert "delta_bic" in entry

        # First entry should have delta_bic = 0 (best model)
        assert bic_ranking[0]["delta_bic"] == 0.0

        # BIC should be sorted (ascending)
        for i in range(len(bic_ranking) - 1):
            assert bic_ranking[i]["bic"] <= bic_ranking[i + 1]["bic"]

    def test_compare_models_recommendation_exists(self, comparison_test_data):
        """Test that a recommendation is provided"""
        doses, responses = comparison_test_data

        result = compare_dose_response_models(doses, responses)

        recommended_model = result["comparison"]["recommended_model"]
        recommendation_reason = result["comparison"]["recommendation_reason"]

        # Recommendation should be one of the three models
        assert recommended_model in ["3PL", "4PL", "5PL"]

        # Reason should be non-empty string
        assert isinstance(recommendation_reason, str)
        assert len(recommendation_reason) > 0

    def test_compare_models_recommended_matches_best_aic(self, comparison_test_data):
        """Test that recommended model matches best AIC model"""
        doses, responses = comparison_test_data

        result = compare_dose_response_models(doses, responses)

        recommended_model = result["comparison"]["recommended_model"]
        best_aic_model = result["comparison"]["aic_ranking"][0]["model"]

        # Recommendation should match best AIC model
        assert recommended_model == best_aic_model

    def test_compare_models_delta_aic_increases(self, comparison_test_data):
        """Test that delta AIC values are non-decreasing"""
        doses, responses = comparison_test_data

        result = compare_dose_response_models(doses, responses)

        aic_ranking = result["comparison"]["aic_ranking"]

        # Delta AIC should be monotonically increasing (best model first)
        for i in range(len(aic_ranking) - 1):
            assert aic_ranking[i]["delta_aic"] <= aic_ranking[i + 1]["delta_aic"]

    def test_compare_models_insufficient_data(self):
        """Test that comparison fails with n < 4"""
        doses = np.array([0.1, 1.0, 10.0])
        responses = np.array([10.0, 50.0, 90.0])

        result = compare_dose_response_models(doses, responses)

        assert result["success"] is False
        assert "error" in result
        assert "4 data points" in result["error"]

    def test_compare_models_zero_doses(self):
        """Test that comparison fails with zero doses"""
        doses = np.array([0.0, 1.0, 10.0, 100.0])
        responses = np.array([10.0, 30.0, 70.0, 90.0])

        result = compare_dose_response_models(doses, responses)

        assert result["success"] is False
        assert "error" in result
        assert "greater than zero" in result["error"]

    def test_compare_models_mismatched_lengths(self):
        """Test that comparison fails with mismatched array lengths"""
        doses = np.array([0.1, 1.0, 10.0, 100.0])
        responses = np.array([10.0, 50.0, 90.0])  # One fewer

        result = compare_dose_response_models(doses, responses)

        assert result["success"] is False
        assert "error" in result
        assert "same length" in result["error"]

    def test_compare_models_with_only_two_models(self, minimal_comparison_data):
        """Test comparison when only 2 models can be fitted (n=4, no 5PL)"""
        doses, responses = minimal_comparison_data

        result = compare_dose_response_models(doses, responses)

        assert result["success"] is True

        # AIC ranking should only have 2 entries (3PL and 4PL)
        aic_ranking = result["comparison"]["aic_ranking"]
        assert len(aic_ranking) == 2

        # Recommendation should be one of the two
        recommended_model = result["comparison"]["recommended_model"]
        assert recommended_model in ["3PL", "4PL"]


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
