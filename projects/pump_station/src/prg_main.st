PROGRAM PRG_MainLogic
    VAR_INPUT
        IN_StartBtn : BOOL;
        IN_StopBtn  : BOOL;
        IN_Fault    : BOOL;
        IN_Level    : REAL;
    END_VAR
    VAR_OUTPUT
        OUT_Pump    : BOOL;
        OUT_Valve   : BOOL;
        OUT_Heater  : BOOL;
    END_VAR
    VAR RETAIN
        TotalRunSeconds : DINT := 0;
        CycleCounter    : UDINT := 0;
        LowSetpoint     : REAL := 25.0;
        HighSetpoint    : REAL := 85.0;
    END_VAR
    VAR
        AutoMode    : BOOL := TRUE;
        ClampedLvl  : REAL := 0.0;
        HystFB      : FB_HysteresisPump;
        SecTimer    : TON;
        PrevPump    : BOOL;
    END_VAR
    IF IN_Fault OR IN_StopBtn THEN
        AutoMode := FALSE;
    ELSIF IN_StartBtn THEN
        AutoMode := TRUE;
    END_IF;
    ClampedLvl := F_ClampPercent(Val := IN_Level);
    HystFB(Enable := AutoMode AND NOT IN_Fault, Level := ClampedLvl, LowLim := LowSetpoint, HighLim := HighSetpoint);
    OUT_Pump := HystFB.PumpCmd;
    OUT_Valve := ClampedLvl > 90.0;
    OUT_Heater := AutoMode AND (ClampedLvl > 20.0);
    IF OUT_Pump AND NOT PrevPump THEN
        CycleCounter := CycleCounter + 1;
    END_IF;
    PrevPump := OUT_Pump;
    SecTimer(IN := OUT_Pump, PT := T#1s);
    IF SecTimer.Q THEN
        TotalRunSeconds := TotalRunSeconds + 1;
        SecTimer(IN := FALSE);
    END_IF;
END_PROGRAM
