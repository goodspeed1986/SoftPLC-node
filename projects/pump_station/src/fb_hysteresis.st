FUNCTION_BLOCK FB_HysteresisPump
    VAR_INPUT
        Enable    : BOOL;
        Level     : REAL;
        LowLim    : REAL;
        HighLim   : REAL;
    END_VAR
    VAR_OUTPUT
        PumpCmd   : BOOL;
    END_VAR
    VAR
        Latched   : BOOL := FALSE;
    END_VAR
    IF NOT Enable THEN
        Latched := FALSE;
    ELSIF Level < LowLim THEN
        Latched := TRUE;
    ELSIF Level >= HighLim THEN
        Latched := FALSE;
    END_IF;
    PumpCmd := Enable AND Latched;
END_FUNCTION_BLOCK
