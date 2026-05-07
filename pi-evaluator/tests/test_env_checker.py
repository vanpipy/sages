"""Tests for pi_evaluator.env_checker module."""



from pi_evaluator.env_checker import (
    ValidationResult,
    check_datasets_library,
    check_evaluate_library,
    check_pi_binary,
    check_python_version,
    validate_all,
)


class TestCheckPythonVersion:
    """Tests for Python version check."""

    def test_check_passes(self):
        """Test Python version check passes for 3.10+."""
        passed, message = check_python_version()
        assert passed is True
        assert "Python" in message
        assert "3.10" in message or "3.11" in message or "3.12" in message or "3.13" in message


class TestCheckEvaluateLibrary:
    """Tests for evaluate library check."""

    def test_library_installed(self):
        """Test evaluate library check."""
        passed, message = check_evaluate_library()
        # Either installed or not
        assert isinstance(passed, bool)
        assert "evaluate" in message.lower() or "not installed" in message.lower()


class TestCheckDatasetsLibrary:
    """Tests for datasets library check."""

    def test_library_installed(self):
        """Test datasets library check."""
        passed, message = check_datasets_library()
        # Either installed or not
        assert isinstance(passed, bool)
        assert "datasets" in message.lower() or "not installed" in message.lower()


class TestCheckPiBinary:
    """Tests for pi binary check."""

    def test_pi_binary_check(self):
        """Test pi binary check."""
        passed, message = check_pi_binary("nonexistent_pi_binary_xyz")
        assert passed is False
        assert "not found" in message.lower()

    def test_pi_binary_with_valid_path(self):
        """Test with a potentially valid pi path."""
        passed, message = check_pi_binary("pi")
        # May pass or fail depending on environment
        assert isinstance(passed, bool)


class TestValidationResult:
    """Tests for ValidationResult class."""

    def test_valid_result(self):
        """Test valid validation result."""
        result = ValidationResult(valid=True)
        result.add_check("Test 1", True)
        result.add_check("Test 2", True)
        assert result.valid is True
        assert len(result.errors) == 0

    def test_invalid_result(self):
        """Test invalid validation result."""
        result = ValidationResult(valid=True)
        result.add_check("Test 1", True)
        result.add_check("Test 2", False, "Failed")
        assert result.valid is False
        assert len(result.errors) == 1
        assert "Failed" in result.errors[0]

    def test_add_info(self):
        """Test adding info to result."""
        result = ValidationResult(valid=True)
        result.add_info("version", "1.0.0")
        assert result.info["version"] == "1.0.0"

    def test_to_dict(self):
        """Test result serialization."""
        result = ValidationResult(valid=True)
        result.add_check("Test", True)
        result.add_info("key", "value")

        data = result.to_dict()
        assert data["valid"] is True
        assert "Test" in data["checks"]
        assert data["info"]["key"] == "value"

    def test_str_representation(self):
        """Test string representation."""
        result = ValidationResult(valid=True)
        result.add_check("Passed Check", True)
        result.add_check("Failed Check", False)

        str_repr = str(result)
        assert "Passed Check" in str_repr
        assert "Failed Check" in str_repr
        assert "✅" in str_repr
        assert "❌" in str_repr


class TestValidateAll:
    """Tests for validate_all function."""

    def test_validate_all_returns_result(self):
        """Test that validate_all returns a ValidationResult."""
        result = validate_all()
        assert isinstance(result, ValidationResult)
        assert "Python >= 3.10" in result.checks
        assert "HuggingFace evaluate" in result.checks
        assert "HuggingFace datasets" in result.checks
        assert "pi binary" in result.checks

    def test_python_check_included(self):
        """Test that Python check is always included."""
        result = validate_all()
        assert "Python >= 3.10" in result.checks
