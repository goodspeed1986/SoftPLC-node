FUNCTION F_ClampPercent : REAL
    VAR_INPUT
        Val : REAL;
    END_VAR
    IF Val < 0.0 THEN
        F_ClampPercent := 0.0;
    ELSIF Val > 100.0 THEN
        F_ClampPercent := 100.0;
    ELSE
        F_ClampPercent := Val;
    END_IF;
END_FUNCTION
