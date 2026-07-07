const testCases = [
    // Le cas original qui a échoué chez l'utilisateur
    `Commander Profile
Vaylah
RADJ The_Radiant
#1061`,

    // Cas standard
    `Jon Snow
[GE] Galactic-Empire
#1061`,
    
    // Cas avec crochets dégradés
    `Natalie
(GE) Galactic-Empire
#1062`,

    // Nouveau cas de bug complexe avec faux badge [544] dans l'avatar et lignes mélangées
    `PROFILE
HawkTuah
RAD The_Radiant
[544]
#1061 Abyss Region
Energy Core Lvl 30`,

    // Test cases for PR1M
    `Vaylah
[PR1M] Primordial
#1061`,

    `Vaylah
PR1M Primordial
#1061`,

    `Vaylah
[PR1M]
#1061`,

    `Vaylah
1PR1M1 Primordial
#1061`,

    `Vaylah
[PR1 M] Primordial
#1061`,

    `Vaylah
[PR 1M] Primordial
#1061`,

    `Vaylah
[PR 1 M] Primordial
#1061`
];

function cleanName(line) {
    // Retire les symboles étranges au début/fin de ligne
    let cleaned = line.replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '').trim();
    
    // Enlever un éventuel préfixe "Lv. XX" ou "LvXX" ou "Lv XX"
    cleaned = cleaned.replace(/^(?:Lv\.?\s*\d+)/i, '').trim();

    // Enlever les éventuelles icônes/lettres isolées de 1 ou 2 caractères au début (ex : "i HawkTuah" -> "HawkTuah")
    const words = cleaned.split(/\s+/);
    if (words.length > 1 && words[0].length <= 2) {
        words.shift();
        cleaned = words.join(' ');
    }

    // Conserver uniquement lettres, chiffres, espaces, tirets et tirets du bas, max 20 chars
    cleaned = cleaned.replace(/[^a-zA-Z0-9 _\-]/g, '').substring(0, 20).trim();
    return cleaned;
}

function isNoiseLine(line) {
    const upper = line.toUpperCase();
    
    // Filtre les labels système connus du profil de jeu
    if (upper.includes('PROFILE') || upper.includes('COMMANDER')) return true;
    if (upper.includes('POWER')) return true;
    if (upper.includes('GLORY')) return true;
    if (upper.includes('ENERGY CORE')) return true;
    if (upper.includes('ACTION POINT')) return true;
    if (upper.includes('APPEARANCE')) return true;
    if (upper.includes('ENCYCLOPEDIA') || upper.includes('GALACTICA')) return true;
    if (upper.includes('RANKING')) return true;
    if (upper.includes('SETTINGS')) return true;
    
    // Filtre les lignes composées uniquement de chiffres et délimiteurs (likes, power, etc.)
    // Ex: "1,024", "86,194,743", "300/300", "3,120"
    if (/^[0-9\s,.\/+]+$/.test(line.trim())) return true;
    
    return false;
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectAllowedGuild(text) {
    const upper = text.toUpperCase();
    
    const checkPattern = (regexPattern, guildName) => {
        const match = upper.match(regexPattern);
        if (!match) return null;
        
        const matchIndex = match.index;
        const matchedStr = match[0];
        
        if (matchIndex > 0) {
            const charBefore = upper[matchIndex - 1];
            if (/[a-zA-Z0-9]/.test(charBefore) && !/[1LI|]/.test(charBefore)) {
                return null;
            }
        }
        
        const nextIndex = matchIndex + matchedStr.length;
        if (nextIndex < upper.length) {
            const charAfter = upper[nextIndex];
            if (/[a-zA-Z0-9]/.test(charAfter) && !/[1LI|]/.test(charAfter)) {
                return null;
            }
        }
        
        return { guild: guildName, matchedStr };
    };

    // PR1M patterns
    let res = checkPattern(/P\s*R\s*[1LI|]\s*M/i, 'PR1M');
    if (res) return res;
    
    // OMG patterns
    res = checkPattern(/[O0]\s*M\s*G/i, 'OMG');
    if (res) return res;
    
    // IMK patterns
    res = checkPattern(/[1LI|]\s*M\s*K/i, 'IMK');
    if (res) return res;
    
    return null;
}

function parseOCRText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(line => line !== '');
    
    let guildTag = "[GuildeInconnue]";
    let playerName = "NomInconnu";
    let serverNumber = "";
    
    // 1. Trouver la ligne du serveur (notre ancre la plus stable)
    let serverLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        const serverMatch = lines[i].match(/(?:#|No|No\.|N°|S|H|h)\s*([0-9oO]{3,5})/i);
        if (serverMatch) {
            const cleanDigits = serverMatch[1].replace(/[oO]/g, '0');
            serverNumber = ` #${cleanDigits}`;
            serverLineIndex = i;
            break;
        }
    }

    // 2. Extraire les lignes candidates en filtrant le serveur et le bruit de l'UI
    const candidates = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (i === serverLineIndex) continue;
        if (isNoiseLine(line)) continue;
        candidates.push({
            text: line,
            originalIndex: i
        });
    }

    let winningGuildLine = null;
    let bestGuildScore = -1;

    // 3. Score pour trouver la ligne de Guilde / Alliance
    for (const cand of candidates) {
        let score = 0;
        let extractedTag = "";
        
        // Tenter de détecter directement une de nos guildes autorisées de manière robuste
        const detected = detectAllowedGuild(cand.text);
        
        if (detected) {
            extractedTag = detected.guild;
            const remainingText = cand.text.replace(new RegExp(escapeRegExp(detected.matchedStr), 'i'), '').trim();
            const cleanRemaining = remainingText.replace(/[\s\[\](){}|\\\/1lI]/g, '');
            if (cleanRemaining.length >= 2) {
                score = 12;
            } else {
                score = 10;
            }
        } else {
            // Recherche d'un tag entre crochets (même dégradés)
            const bracketMatch = cand.text.match(/(?:\[|\(|\{|\(|\||l|I|1|\\|\/)\s*([a-zA-Z0-9_-]{2,6})\s*(?:\]|\)|\}|\)|\||l|I|1|\\|\/)/);
            
            if (bracketMatch) {
                extractedTag = bracketMatch[1].trim().toUpperCase();
                // Si la ligne contient du texte après le tag, c'est un excellent candidat d'alliance
                // Ex: "[RAD] The_Radiant" vs juste un badge égaré "[544]"
                const remainingText = cand.text.replace(bracketMatch[0], '').trim();
                if (remainingText.length >= 2) {
                    score = 10;
                } else {
                    score = 3;
                }
            } else {
            // Sans crochets, cherche si la ligne commence par un mot court (tag) suivi du nom
            // Ex: "RAD The_Radiant"
            const firstWordMatch = cand.text.match(/^([a-zA-Z0-9_-]{2,6})\s+([a-zA-Z0-9_-]+)/);
            if (firstWordMatch) {
                extractedTag = firstWordMatch[1].trim().toUpperCase();
                score = 8;
            } else {
                // Simple mot court
                const singleWordMatch = cand.text.match(/^([a-zA-Z0-9_-]{2,6})$/);
                if (singleWordMatch) {
                    extractedTag = singleWordMatch[1].trim().toUpperCase();
                    score = 1;
                }
            }
        }
        }

        // Pénaliser légèrement les tags purement numériques (ex: 544 issu d'une erreur d'OCR sur un logo)
        if (score > 0 && /^\d+$/.test(extractedTag)) {
            score -= 2;
        }

        if (score > bestGuildScore && score > 0) {
            bestGuildScore = score;
            guildTag = `[${extractedTag}]`;
            winningGuildLine = cand;
        }
    }

    // 4. Score pour trouver le Pseudo du Joueur
    let bestPlayerScore = -1;
    for (const cand of candidates) {
        // Exclure la ligne gagnante de Guilde
        if (winningGuildLine && cand.originalIndex === winningGuildLine.originalIndex) continue;
        
        let score = 0;
        
        // Le pseudo est typiquement situé au-dessus de la ligne d'alliance dans l'ordre vertical de l'interface
        if (winningGuildLine) {
            if (cand.originalIndex < winningGuildLine.originalIndex) {
                const distance = winningGuildLine.originalIndex - cand.originalIndex;
                score += 5 + (1 / distance); // Préférence pour les lignes juste au-dessus
            } else {
                score += 1;
            }
        } else {
            score += 5 - (cand.originalIndex * 0.5);
        }
        
        const clean = cleanName(cand.text);
        if (clean.length >= 3) {
            // Préférence pour les mots uniques et propres (les pseudos n'ont généralement pas d'espaces)
            if (!/\s+/.test(clean)) {
                score += 3;
            } else {
                score += 1;
            }
            
            // Pénaliser les lignes contenant des caractères typiques de tags/parenthèses ou trop de symboles
            if (/[#@\[\]()]/g.test(cand.text)) {
                score -= 3;
            }
            
            if (score > bestPlayerScore) {
                bestPlayerScore = score;
                playerName = clean;
            }
        }
    }

    // 5. Cas de secours robuste (Ligne fusionnée) :
    // Si aucun pseudo séparé n'a été trouvé mais qu'on a identifié une guilde valide,
    // on extrait le pseudo directement depuis le reste de cette ligne de guilde.
    if ((playerName === "NomInconnu" || playerName.length < 3) && winningGuildLine) {
        const line = winningGuildLine.text;
        const matchBefore = line.match(/^([a-zA-Z0-9_-]{3,20})\s*(?:\[|\(|\{|\(|\||l|I|1|\\|\/)/);
        if (matchBefore) {
            playerName = cleanName(matchBefore[1]);
        } else {
            const matchAfter = line.match(/(?:\]|\)|\}|\)|\||l|I|1|\\|\/)\s*([a-zA-Z0-9_-]{3,20})/);
            if (matchAfter) {
                playerName = cleanName(matchAfter[1]);
            }
        }
    }

    return {
        guildTag,
        playerName,
        serverNumber
    };
}

// Lancement des tests
testCases.forEach((tc, idx) => {
    const res = parseOCRText(tc);
    console.log(`--- Test ${idx + 1} ---`);
    console.log(`Texte:\n${tc}`);
    console.log(`Résultats du parsing :`);
    console.log(`  Tag de Guilde  : ${res.guildTag}`);
    console.log(`  Nom du Joueur  : ${res.playerName}`);
    console.log(`  N° de Serveur  : ${res.serverNumber || "Non trouvé"}`);
    console.log(`-----------------\n`);
});
