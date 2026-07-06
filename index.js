require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    Events, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle 
} = require('discord.js');
const axios = require('axios');
const express = require('express');

// ── Validation de la configuration au démarrage ──────────────────────────────
if (!process.env.DISCORD_TOKEN) {
    console.error('❌ DISCORD_TOKEN is missing from .env — aborting.');
    process.exit(1);
}
if (!process.env.OCR_SPACE_KEY) {
    console.error('❌ OCR_SPACE_KEY is missing from .env — aborting.');
    process.exit(1);
}

const VERIFICATION_CHANNEL_NAME = process.env.VERIFICATION_CHANNEL_NAME || '✅-verification';

// ── Serveur Express pour le Keep-Alive Render ───────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('🤖 Discord OCR Bot is active and running! Port binding successful.');
});

app.listen(PORT, () => {
    console.log(`📡 Keep-alive server running on port ${PORT}`);
});

// ── Configuration des Guildes et Rôles ───────────────────────────────────────
const ALLOWED_GUILDS = ['PR1M', 'OMG', 'IMK'];

/**
 * Normalise le tag de guilde. S'il n'est pas dans la liste des guildes autorisées,
 * retourne '[VISITOR]'. Sinon, retourne le tag normalisé sous la forme '[TAG]'.
 */
function normalizeGuildTag(tag) {
    if (!tag || tag === '[GuildeInconnue]') {
        return '[VISITOR]';
    }
    const clean = tag.replace(/[\[\]]/g, '').trim().toUpperCase();
    if (ALLOWED_GUILDS.includes(clean)) {
        return `[${clean}]`;
    }
    return '[VISITOR]';
}

// ── Gestion de l'état en mémoire ─────────────────────────────────────────────
// Anti-spam : 1 traitement actif par utilisateur à la fois
const processingUsers = new Set();
// Session de vérification en attente de clic bouton : userId -> { guildTag, playerName, serverNumber }
const pendingVerifications = new Map();

// ── Client Discord ──────────────────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once(Events.ClientReady, async c => {
    console.log(`✅ Ready! Logged in as ${c.user.tag}`);
    try {
        await processOldMessages(c);
    } catch (err) {
        console.error("Error during startup catch-up:", err);
    }
});

// ── Fonctions Utilitaires OCR & Parsing ──────────────────────────────────────

/**
 * Appelle l'API gratuite d'OCR.space pour extraire le texte d'une image
 */
async function performOCRSpace(imageUrl) {
    try {
        const formData = new URLSearchParams();
        formData.append('apikey', process.env.OCR_SPACE_KEY);
        formData.append('url', imageUrl);
        formData.append('language', 'eng');
        formData.append('isOverlayRequired', 'false');
        formData.append('detectOrientation', 'true');
        formData.append('scale', 'true'); // Agrandit l'image en interne pour une meilleure précision
        formData.append('OCREngine', '2'); // Utilise le moteur 2 d'OCR.space (bien plus précis pour les chiffres, crochets et polices de jeu)

        const response = await axios.post('https://api.ocr.space/parse/image', formData, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        if (response.data && response.data.ParsedResults && response.data.ParsedResults.length > 0) {
            const parsedText = response.data.ParsedResults[0].ParsedText;
            return parsedText || '';
        } else {
            console.error('OCR.space Error Response:', response.data);
            throw new Error(response.data.ErrorMessage || 'No text found or API limit reached');
        }
    } catch (error) {
        console.error('Error during OCR.space request:', error.message);
        throw error;
    }
}

/**
 * Nettoie le pseudo en enlevant le niveau "Lv. 60" ou les caractères isolés au début
 */
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

/**
 * Détermine si une ligne est un bruit typique de l'interface du jeu
 */
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

/**
 * Parse le texte brut extrait par l'OCR avec des regex ultra-résilientes
 */
function parseOCRText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(line => line !== '');
    console.log(`[OCR.space Lines]:`, lines);

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
        serverNumber,
        isGuildFound: guildTag !== "[GuildeInconnue]"
    };
}

/**
 * Applique le rôle de guilde et met à jour le pseudo du membre Discord
 */
async function applyVerification(member, guildTag, playerName, serverNumber, interaction) {
    const guild = member.guild;
    const finalGuildTag = normalizeGuildTag(guildTag);

    // 1. Gestion du rôle de guilde
    await guild.roles.fetch();
    let role = guild.roles.cache.find(r => r.name.toLowerCase() === finalGuildTag.toLowerCase());

    if (!role) {
        // Crée le rôle si inexistant (avec une couleur aléatoire)
        role = await guild.roles.create({
            name: finalGuildTag,
            color: Math.floor(Math.random() * 16777215),
            reason: 'Automatically created by the OCR bot upon successful user verification',
        });
    }

    // Assigne le rôle au membre
    await member.roles.add(role);

    // 2. Renommer le membre : [GUILDE] Pseudo #Serveur
    const finalServer = serverNumber ? `${serverNumber}` : "";
    const newNickname = `${finalGuildTag} ${playerName}${finalServer}`;

    // Discord limite le pseudo à 32 caractères
    await member.setNickname(newNickname.substring(0, 32));

    // 3. Message de confirmation
    await interaction.editReply({
        content: `🎉 **Verification successful!**\n* Assigned Role: **${finalGuildTag}**\n* Nickname Set: **${newNickname.substring(0, 32)}**`
    });
}

// ── Fonctions de Traitement de Messages & Catch-up ───────────────────────────

/**
 * Parcourt les salons de vérification pour traiter les messages en attente (catch-up)
 */
async function processOldMessages(client) {
    console.log("🔍 Checking for unprocessed screenshots in the verification channel...");
    for (const guild of client.guilds.cache.values()) {
        const channel = guild.channels.cache.find(ch => ch.name === VERIFICATION_CHANNEL_NAME && ch.isTextBased());
        if (!channel) continue;

        try {
            // Récupère les 100 derniers messages
            const messages = await channel.messages.fetch({ limit: 100 });
            
            // Filtre pour garder les captures d'écran non traitées
            const unprocessed = messages.filter(msg => {
                if (msg.author.bot) return false;
                return msg.attachments.some(att => att.contentType && att.contentType.startsWith('image/'));
            });

            if (unprocessed.size > 0) {
                console.log(`[Catch-up] Found ${unprocessed.size} unprocessed messages in '${VERIFICATION_CHANNEL_NAME}' (${guild.name})`);
                
                // Traitement dans l'ordre chronologique (du plus ancien au plus récent)
                const sorted = Array.from(unprocessed.values()).reverse();
                for (const msg of sorted) {
                    try {
                        await handleScreenshotMessage(msg);
                    } catch (err) {
                        console.error(`Failed to process message ${msg.id} during catch-up:`, err);
                    }
                }
            } else {
                console.log(`[Catch-up] No unprocessed messages in '${VERIFICATION_CHANNEL_NAME}' (${guild.name})`);
            }
        } catch (error) {
            console.error(`Failed to fetch messages for guild ${guild.name}:`, error);
        }
    }
}

/**
 * Traite une image de capture d'écran reçue (OCR + Embed de validation)
 */
async function handleScreenshotMessage(message) {
    const attachment = message.attachments.first();
    if (!attachment) return;

    // Rate-limit : ignore si l'utilisateur a déjà un traitement actif
    if (processingUsers.has(message.author.id)) {
        const waitMsg = await message.reply('⏳ Please wait, your previous image is still being processed.');
        setTimeout(async () => {
            try { await message.delete(); } catch (e) {}
            try { await waitMsg.delete(); } catch (e) {}
        }, 5000);
        return;
    }

    // Vérif format d'image
    const isImage = attachment.contentType && attachment.contentType.startsWith('image/');
    if (!isImage) return;

    console.log(`📸 Profile image received/extracted from ${message.author.tag}`);
    processingUsers.add(message.author.id);

    let processingMsg;
    try {
        // Indique que le traitement OCR a commencé
        processingMsg = await message.reply('⏳ Processing image (OCR.space)...');

        // Exécution de l'OCR en ligne (gratuit et sans charge CPU locale !)
        const ocrText = await performOCRSpace(attachment.url);
        console.log(`[OCR Result text]:\n${ocrText}`);

        // Analyse et extraction des informations
        const parsedData = parseOCRText(ocrText);
        
        // Enregistrement de la session utilisateur en mémoire
        pendingVerifications.set(message.author.id, {
            guildTag: parsedData.guildTag,
            playerName: parsedData.playerName,
            serverNumber: parsedData.serverNumber.trim()
        });

        // Supprimer IMMÉDIATEMENT le message d'origine et le message temporaire
        // (L'image a déjà été traitée, on nettoie pour garder le salon propre)
        try { await message.delete(); } catch (e) {}
        try { await processingMsg.delete(); } catch (e) {}

        const finalGuild = normalizeGuildTag(parsedData.guildTag);
        let displayGuild = finalGuild;
        if (finalGuild === '[VISITOR]') {
            if (parsedData.guildTag !== '[GuildeInconnue]' && parsedData.guildTag.toUpperCase() !== '[VISITOR]') {
                displayGuild = `[VISITOR] (Detected: ${parsedData.guildTag})`;
            } else if (parsedData.guildTag === '[GuildeInconnue]') {
                displayGuild = `[VISITOR] (Not detected)`;
            }
        }

        // Construction de l'Embed de résultat
        const embed = new EmbedBuilder()
            .setColor(parsedData.isGuildFound ? 0x2ecc71 : 0xe74c3c)
            .setTitle('🔍 Profile Analysis Result')
            .setDescription(parsedData.isGuildFound 
                ? `Automatic analysis succeeded. Please verify your information below.\n\n*Click on **Confirm** if everything is correct, or **Edit** if there is a typo.*`
                : `⚠️ **The guild tag could not be detected automatically.**\n\n*Don't worry! Click the **Edit / Complete** button below to manually enter your details.*`)
            .addFields(
                { name: 'Guild (Role)', value: displayGuild, inline: true },
                { name: 'Player Nickname', value: parsedData.playerName, inline: true },
                { name: 'Server Number', value: parsedData.serverNumber.trim() || 'Not detected', inline: true }
            )
            .setFooter({ text: `Verification for ${message.author.username}`, iconURL: message.author.displayAvatarURL() });

        // Ligne de boutons interactifs
        const row = new ActionRowBuilder();

        if (parsedData.isGuildFound) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`confirm_${message.author.id}`)
                    .setLabel('Confirm')
                    .setStyle(ButtonStyle.Success)
            );
        }

        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`edit_${message.author.id}`)
                .setLabel('Edit / Complete')
                .setStyle(ButtonStyle.Secondary)
        );

        // Envoi de la fiche interactive dans le salon de vérification
        const responseMsg = await message.channel.send({
            content: `<@${message.author.id}>`,
            embeds: [embed],
            components: [row]
        });

        // Auto-destruction après 3 minutes d'inactivité pour éviter de polluer le salon
        setTimeout(async () => {
            if (pendingVerifications.has(message.author.id)) {
                pendingVerifications.delete(message.author.id);
                try {
                    await responseMsg.delete();
                } catch (e) {}
            }
        }, 180000); // 3 minutes

    } catch (error) {
        console.error("Error during image processing:", error);
        const catchMsg = await message.channel.send(`❌ An error occurred while analyzing the image of <@${message.author.id}>. Please try again or contact an administrator.`);
        
        // Nettoyage
        try { await message.delete(); } catch (e) {}
        if (processingMsg) { try { await processingMsg.delete(); } catch (e) {} }

        setTimeout(async () => {
            try { await catchMsg.delete(); } catch (e) {}
        }, 10000);
    } finally {
        // Libère le verrou anti-spam
        processingUsers.delete(message.author.id);
    }
}

// ── Gestionnaire de messages (Détection d'images) ───────────────────────────

client.on(Events.MessageCreate, async message => {
    // Ignore les messages de bots
    if (message.author.bot) return;

    // Traite uniquement dans le salon configuré
    if (message.channel.name !== VERIFICATION_CHANNEL_NAME) return;

    // Vérifie s'il y a une capture d'écran
    if (message.attachments.size > 0) {
        await handleScreenshotMessage(message);
    }
});

// ── Gestionnaire d'Interactions (Boutons & Modals) ──────────────────────────

client.on(Events.InteractionCreate, async interaction => {
    // 1. Clic sur un bouton
    if (interaction.isButton()) {
        const [action, targetUserId] = interaction.customId.split('_');

        // Sécurité : Seul l'auteur de l'image peut cliquer sur ses boutons
        if (interaction.user.id !== targetUserId) {
            return await interaction.reply({
                content: "❌ Only the user who sent the image can interact with these buttons.",
                ephemeral: true
            });
        }

        const data = pendingVerifications.get(targetUserId);
        if (!data) {
            return await interaction.reply({
                content: "❌ Your verification session has expired or was not found. Please resend your screenshot.",
                ephemeral: true
            });
        }

        // Clic sur "Confirm"
        if (action === 'confirm') {
            await interaction.deferReply({ ephemeral: true });

            try {
                await applyVerification(interaction.member, data.guildTag, data.playerName, data.serverNumber, interaction);
                pendingVerifications.delete(targetUserId);

                // Supprime la fiche de boutons du salon
                try { await interaction.message.delete(); } catch (e) {}
            } catch (err) {
                console.error("Verification application error:", err);
                let errMsg = "A permission error prevents the bot from modifying your roles or nickname.";
                if (err.code === 50013) {
                    errMsg += "\n*Note for admins: Ensure the bot's role is placed higher than the guild roles in your server settings.*";
                } else {
                    errMsg += `\nDetails: ${err.message}`;
                }
                await interaction.editReply({ content: `❌ ${errMsg}` });
            }
        }

        // Clic sur "Modifier"
        else if (action === 'edit') {
            // Construction du Modal (Formulaire contextuel)
            const modal = new ModalBuilder()
                .setCustomId(`modal_${targetUserId}`)
                .setTitle('Correct your information');

            const prefillGuild = (data.guildTag === '[GuildeInconnue]' || !data.guildTag) 
                ? '' 
                : data.guildTag.replace(/[\[\]]/g, '');

            const guildInput = new TextInputBuilder()
                .setCustomId('guild_tag')
                .setLabel('GUILD TAG (e.g., GE)')
                .setStyle(TextInputStyle.Short)
                .setValue(prefillGuild) // Pré-remplit sans les crochets ou vide
                .setMinLength(2)
                .setMaxLength(10)
                .setPlaceholder('GE')
                .setRequired(true);

            const nameInput = new TextInputBuilder()
                .setCustomId('player_name')
                .setLabel('IN-GAME NICKNAME')
                .setStyle(TextInputStyle.Short)
                .setValue(data.playerName === 'NomInconnu' ? '' : data.playerName)
                .setMinLength(3)
                .setMaxLength(20)
                .setPlaceholder('Your exact nickname')
                .setRequired(true);

            const serverInput = new TextInputBuilder()
                .setCustomId('server_number')
                .setLabel('SERVER NUMBER (e.g., 1061)')
                .setStyle(TextInputStyle.Short)
                .setValue(data.serverNumber.replace(/#/g, '').trim())
                .setMinLength(1)
                .setMaxLength(5)
                .setPlaceholder('1061')
                .setRequired(false);

            const row1 = new ActionRowBuilder().addComponents(guildInput);
            const row2 = new ActionRowBuilder().addComponents(nameInput);
            const row3 = new ActionRowBuilder().addComponents(serverInput);

            modal.addComponents(row1, row2, row3);

            // Affiche la fenêtre formulaire à l'utilisateur
            await interaction.showModal(modal);
        }
    }

    // 2. Soumission du formulaire (Modal)
    else if (interaction.isModalSubmit()) {
        const [prefix, targetUserId] = interaction.customId.split('_');

        if (prefix === 'modal') {
            if (interaction.user.id !== targetUserId) {
                return await interaction.reply({
                    content: "❌ Unauthorized action.",
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });

            const rawGuild = interaction.fields.getTextInputValue('guild_tag').trim();
            const rawName = interaction.fields.getTextInputValue('player_name').trim();
            const rawServer = interaction.fields.getTextInputValue('server_number').trim();

            // Formatage propre selon la charte du serveur
            const guildTag = `[${rawGuild.toUpperCase()}]`;
            const playerName = rawName;
            const serverNumber = rawServer ? ` #${rawServer}` : '';

            try {
                await applyVerification(interaction.member, guildTag, playerName, serverNumber, interaction);
                pendingVerifications.delete(targetUserId);

                // Supprime la fiche de boutons du salon
                try { await interaction.message.delete(); } catch (e) {}
            } catch (err) {
                console.error("Verification application error from modal:", err);
                let errMsg = "A permission error prevents the bot from modifying your roles or nickname.";
                if (err.code === 50013) {
                    errMsg += "\n*Note for admins: The bot's role must be placed higher in the role list.*";
                } else {
                    errMsg += `\nDetails: ${err.message}`;
                }
                await interaction.editReply({ content: `❌ ${errMsg}` });
            }
        }
    }
});

// ── Connexion du client Discord ──────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
