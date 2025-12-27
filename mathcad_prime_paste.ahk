#SingleInstance Force
SendMode "Event"
SetKeyDelay 25, 10

; ===== CONFIG =====
mathcadExe := "MathcadPrime.exe"
delayMs := 55

; move count to reach range placeholder after ∈ inside For operator (tune 4..7)
forRightMoves := 5

abort := false
Esc::abort := true

#HotIf WinActive("ahk_exe " . mathcadExe)

v::
{
    global abort, delayMs, forRightMoves
    abort := false
    KeyWait "v"

    text := A_Clipboard
    if (text = "")
        return

    text := StrReplace(text, "`r`n", "`n")
    text := StrReplace(text, "`r", "`n")
    lines := StrSplit(text, "`n")

    ReleaseMods()

    inProgram := false

    for line in lines
    {
        if abort
            break

        line := RemoveAllSpacesTabs(line)
        if (line = "")
            continue

        ; drop методичка-junk: lines like "(((" or ")))" or "(" or ")"
        if RegExMatch(line, "^[()]+$")
            continue

        ; ----- Program header: ...:=
        if RegExMatch(line, "i)^.+:=$")
        {
            ; Type header with keystrokes for : and = (helps Prime recognize definition)
            TypeMathcadLine_WithOperators(line)
            Sleep 220

            ; In Prime, after ":=" caret should be IN the RHS placeholder.
            ; Insert Program immediately so it replaces the RHS placeholder.
            ReleaseMods()
            Send "]"
            Sleep 200

            ; Start first statement line inside Program
            Send "{Enter}"
            Sleep delayMs

            inProgram := true
            continue
        }

        ; If not in Program, just type line as-is (rare)
        if !inProgram
        {
            TypeMathcadLine_WithOperators(line)
            Sleep delayMs
            Send "{Enter}"
            Sleep delayMs
            continue
        }

        ; ----- For loop: fori∈0..7
        if RegExMatch(line, "i)^for(.+?)∈(.+)$", &m)
        {
            idxVar := m[1]
            rng    := m[2]

            ReleaseMods()
            Send "^+{vkDEsc028}"     ; Ctrl+Shift+"  (For Loop operator)
            Sleep 170
            ReleaseMods()

            TypeMathcadLine_WithOperators(idxVar)
            Sleep 120

            ; move to range placeholder WITHOUT Tab
            Send "{Right " . forRightMoves . "}"
            Sleep 120

            TypeMathcadLine_WithOperators(rng)
            Sleep 140

            FinalizeProgramLine()
            Send "{Enter}"
            Sleep delayMs
            continue
        }

        ; ----- Normal Program statement line
        TypeMathcadLine_WithOperators(line)
        Sleep 140
        FinalizeProgramLine()
        Send "{Enter}"
        Sleep delayMs
    }

    ReleaseMods()
}

#HotIf

; ===== Helpers =====

ReleaseMods()
{
    Send "{Ctrl up}{Shift up}{Alt up}{LWin up}{RWin up}"
}

FinalizeProgramLine()
{
    ; Exit nested templates without leaving Program
    ReleaseMods()
    Send "{End}"
    Sleep 20
    Send "{Right}"
    Sleep 20
}

RemoveAllSpacesTabs(s)
{
    ; Normalize whitespace: keep regular spaces, drop NBSP/zero-width, trim edges.
    s := StrReplace(s, "`t", " ")
    s := StrReplace(s, Chr(0x00A0), "")
    s := RegExReplace(s, "[\x{2000}-\x{200B}\x{202F}\x{205F}\x{3000}]", "")
    return Trim(s)
}

IsBlockedWhitespaceChar(ch)
{
    ; Allow normal spaces; block NBSP/zero-width.
    cp := Ord(ch)
    if (cp = 0x00A0)
        return true
    if (cp >= 0x2000 && cp <= 0x200B)
        return true
    if (cp = 0x202F || cp = 0x205F || cp = 0x3000)
        return true

    return false
}

TypeMathcadLine_WithOperators(s)
{
    global abort
    static inSub := false

    i := 1
    while (i <= StrLen(s))
    {
        if abort
            return

        ch := SubStr(s, i, 1)

        if IsBlockedWhitespaceChar(ch)
        {
            i += 1
            continue
        }

        ; Subscript toggle: '_' or '[' -> Ctrl+-
        if (ch = "_")
        {
            ReleaseMods()
            Send "^-"
            inSub := true
            i += 1
            Sleep 10
            continue
        }
        if (ch = "[")
        {
            if (!inSub)
            {
                ReleaseMods()
                Send "^-"
                inSub := true
                Sleep 10
            }
            i += 1
            continue
        }

        ; Subscript explicit exit: ']' -> move out of subscript
        if (ch = "]")
        {
            if (inSub)
            {
                Send "{Right 2}"
                inSub := false
                Sleep 10
            }
            i += 1
            continue
        }

        ; If in subscript and next is "<-" then exit subscript BEFORE assignment (Right 2)
        if (inSub && ch = "<" && i < StrLen(s) && SubStr(s, i+1, 1) = "-")
        {
            Send "{Right 2}"
            inSub := false
            Sleep 15
        }

        ; Local assignment inside Program: "<-" -> { (Prime renders ←)
        if (ch = "<" && i < StrLen(s) && SubStr(s, i+1, 1) = "-")
        {
            ReleaseMods()
            Send "{{}"            ; physical { key (Shift+[ on US)
            i += 2
            Sleep 10
            continue
        }

        ; If clipboard already contains arrow
        if (ch = "←")
        {
            ReleaseMods()
            Send "{{}"
            i += 1
            Sleep 10
            continue
        }

        ; normalize some Unicode chars
        if (ch = "−")
        {
            SendText "-"
            i += 1
            continue
        }
        if (ch = "×")
        {
            SendText "*"
            i += 1
            continue
        }

        ; Greek letters if present in clipboard: Latin + Ctrl+G
        static greek := Map(
            "α","a","β","b","γ","g","δ","d","ε","e","θ","q","λ","l",
            "μ","m","π","p","ρ","r","σ","s","τ","t","φ","f","ω","w"
        )
        if greek.Has(ch)
        {
            ReleaseMods()
            Send greek[ch]
            Sleep 15
            Send "^g"
            i += 1
            continue
        }

        ; Prime shortcuts where text-insert often fails
        switch ch
        {
            case "∞":
                ReleaseMods()
                Send "^+z"
                i += 1
                continue
            case "≤":
                ReleaseMods()
                Send "^9"
                i += 1
                continue
            case "≥":
                ReleaseMods()
                Send "^0"
                i += 1
                continue
            case "∈":
                ReleaseMods()
                Send "^{F7}"
                i += 1
                continue
            case "∫":
                ReleaseMods()
                Send "^+i"
                i += 1
                continue
            case "∑":
                ReleaseMods()
                Send "^+4"
                i += 1
                continue
            case "∏":
                ReleaseMods()
                Send "^+3"
                i += 1
                continue
            case "÷":
                ReleaseMods()
                Send "^/"
                i += 1
                continue
        }

        ; Critical punctuation for Prime parsing (send as keystrokes, not SendText)
        if (ch = ":" || ch = "=")
        {
            ReleaseMods()
            Send ch
            i += 1
            continue
        }

        ; default: send as text (keeps parentheses needed for zeros(8,1), floor(t/2), etc.)
        SendText ch
        i += 1
    }

    ; Exit subscript at end of line (Right 2)
    if (inSub)
    {
        Send "{Right 2}"
        inSub := false
    }
}
