# Version Lock Quick Reference

## Check All Modules

```bash
python_embedded/python.exe python_embedded/statistics_module/verify_versions.py
```

## Check Single Module

```bash
python_embedded/python.exe python_embedded/statistics_module/verify_versions.py --module mediation
```

## Common Workflows

### I changed mediation.py and bumped version to 1.1.1

1. Run validation tests:
   ```bash
   python_embedded/python.exe _test_validation/run_all_python_tests.py --group Group7_Mediation_Moderation
   ```

2. If 18/18 metrics pass:
   - Edit `VALIDATED_VERSIONS.json`: change `"version": "1.1.0"` to `"version": "1.1.1"`
   - Commit both files together
   - Update validation plan version history

3. If tests fail:
   - Revert code changes OR fix the issue

### Verification failed—what now?

```
[FAIL] mediation v1.1.1 - Expected 1.1.0, found 1.1.1
```

**Options:**
1. Revert to v1.1.0 if change was accidental
2. Run validation tests to verify v1.1.1 maintains R parity
3. Update manifest if validation passes

### Emergency bypass

```bash
git commit --no-verify -m "Emergency fix - validation pending"
```

**Use sparingly.** Document why bypass was needed.

## Optional Git Hook

Install pre-commit hook for automatic verification:

```bash
# Linux/Mac/Git Bash
chmod +x .git/hooks/pre-commit

# Copy hook from PYTHON_VERSION_LOCK_PLAN.md
```

Hook is **optional**. Bypass with `--no-verify` if needed.
