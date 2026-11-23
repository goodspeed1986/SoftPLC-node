PROGRAM PRG_Conveyor
    VAR_INPUT
        IN_StartBtn : BOOL;
        IN_StopBtn  : BOOL;
        IN_Fault    : BOOL;
    END_VAR
    VAR_OUTPUT
        OUT_Motor   : BOOL;
        OUT_Alarm   : BOOL;
    END_VAR
    VAR
        Running     : BOOL := FALSE;
    END_VAR
    IF IN_Fault OR IN_StopBtn THEN
        Running := FALSE;
    ELSIF IN_StartBtn THEN
        Running := TRUE;
    END_IF;
    OUT_Motor := Running AND NOT IN_Fault;
    OUT_Alarm := IN_Fault;
END_PROGRAM
