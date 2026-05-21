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

client.once(Events.ClientReady, c => {
    console.log(`✅ Ready! Logged in as ${c.user.tag}`);
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

    // Heuristique A : Basée sur l'ancre du Serveur (Ordre vertical fixe)
    if (serverLineIndex !== -1) {
        console.log(`[Heuristic A] Server found at line ${serverLineIndex}: "${lines[serverLineIndex]}"`);
        
        // La ligne juste au-dessus du serveur est l'Alliance/Guilde
        if (serverLineIndex - 1 >= 0) {
            const allianceLine = lines[serverLineIndex - 1];
            // Cherche d'abord s'il y a un tag entre crochets (même dégradés)
            const tagMatch = allianceLine.match(/(?:\[|\(|\{|\(|\||l|I|1|\\|\/)\s*([a-zA-Z0-9_-]{2,6})\s*(?:\]|\)|\}|\)|\||l|I|1|\\|\/)/);
            if (tagMatch) {
                guildTag = `[${tagMatch[1].trim().toUpperCase()}]`;
            } else {
                // Si pas de crochets, on prend le premier mot (ex: "RADJ The_Radiant" -> "RADJ")
                const firstWord = allianceLine.split(/\s+/)[0].replace(/[^a-zA-Z0-9_-]/g, '');
                if (firstWord.length >= 2 && firstWord.length <= 6) {
                    guildTag = `[${firstWord.toUpperCase()}]`;
                }
            }
        }

        // La ligne encore au-dessus (ou celle d'avant si vide/invalide) est le Pseudo
        for (let i = serverLineIndex - 2; i >= 0; i--) {
            let potentialName = lines[i];
            if (potentialName.toUpperCase().includes('PROFILE') || potentialName.toUpperCase().includes('COMMANDER')) continue;
            
            potentialName = cleanName(potentialName);
            if (potentialName.length >= 3) {
                playerName = potentialName;
                break;
            }
        }
    }

    // Heuristique B (Fallback) : Si l'ancre du serveur a échoué mais qu'on a des crochets
    if (guildTag === "[GuildeInconnue]" || playerName === "NomInconnu") {
        console.log(`[Heuristic B] Fallback to bracket-based search...`);
        let tagLineIndex = -1;
        
        // Détection du tag de guilde par crochets
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(/(?:\[|\(|\{|\(|\||l|I|1|\\|\/)\s*([a-zA-Z0-9_-]{2,6})\s*(?:\]|\)|\}|\)|\||l|I|1|\\|\/)/);
            if (match) {
                guildTag = `[${match[1].trim().toUpperCase()}]`;
                tagLineIndex = i;
                break;
            }
        }

        if (tagLineIndex !== -1) {
            // Cherche le nom du joueur avant la ligne du tag
            if (playerName === "NomInconnu" && tagLineIndex > 0) {
                for (let i = tagLineIndex - 1; i >= 0; i--) {
                    let line = lines[i];
                    if (line.toUpperCase().includes('PROFILE') || line.toUpperCase().includes('COMMANDER')) continue;
                    line = cleanName(line);
                    if (line.length >= 3) {
                        playerName = line;
                        break;
                    }
                }
            }

            // Cas de secours sur la même ligne
            if (playerName === "NomInconnu") {
                const line = lines[tagLineIndex];
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

    // 1. Gestion du rôle de guilde
    await guild.roles.fetch();
    let role = guild.roles.cache.find(r => r.name.toLowerCase() === guildTag.toLowerCase());

    if (!role) {
        // Crée le rôle si inexistant (avec une couleur aléatoire)
        role = await guild.roles.create({
            name: guildTag,
            color: Math.floor(Math.random() * 16777215),
            reason: 'Créé automatiquement par le bot OCR suite à une vérification réussie',
        });
    }

    // Assigne le rôle au membre
    await member.roles.add(role);

    // 2. Renommer le membre : [GUILDE] Pseudo #Serveur
    const finalServer = serverNumber ? `${serverNumber}` : "";
    const newNickname = `${guildTag} ${playerName}${finalServer}`;

    // Discord limite le pseudo à 32 caractères
    await member.setNickname(newNickname.substring(0, 32));

    // 3. Message de confirmation
    await interaction.editReply({
        content: `🎉 **Vérification validée !**\n* Rôle attribué : **${guildTag}**\n* Pseudo défini : **${newNickname.substring(0, 32)}**`
    });
}

// ── Gestionnaire de messages (Détection d'images) ───────────────────────────

client.on(Events.MessageCreate, async message => {
    // Ignore les messages de bots
    if (message.author.bot) return;

    // Traite uniquement dans le salon configuré
    if (message.channel.name !== VERIFICATION_CHANNEL_NAME) return;

    // Vérifie s'il y a une capture d'écran
    if (message.attachments.size > 0) {
        const attachment = message.attachments.first();

        // Rate-limit : ignore si l'utilisateur a déjà un traitement actif
        if (processingUsers.has(message.author.id)) {
            const waitMsg = await message.reply('⏳ Veuillez patienter, votre image précédente est toujours en cours de traitement.');
            setTimeout(async () => {
                try { await message.delete(); } catch (e) {}
                try { await waitMsg.delete(); } catch (e) {}
            }, 5000);
            return;
        }

        // Vérif format d'image
        const isImage = attachment.contentType && attachment.contentType.startsWith('image/');
        if (!isImage) return;

        console.log(`📸 Image de profil reçue de ${message.author.tag}`);
        processingUsers.add(message.author.id);

        let processingMsg;
        try {
            // Indique que le traitement OCR a commencé
            processingMsg = await message.reply('⏳ Analyse de l\'image en cours (OCR.space)...');

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

            // Construction de l'Embed de résultat
            const embed = new EmbedBuilder()
                .setColor(parsedData.isGuildFound ? 0x2ecc71 : 0xe74c3c)
                .setTitle('🔍 Résultat de l\'analyse de profil')
                .setDescription(parsedData.isGuildFound 
                    ? `L'analyse automatique a réussi. Veuillez vérifier vos informations ci-dessous.\n\n*Cliquez sur **Confirmer** si tout est exact, ou sur **Modifier** si l'OCR a fait une faute de frappe.*`
                    : `⚠️ **Le tag de guilde n'a pas pu être détecté automatiquement.**\n\n*Ne vous inquiétez pas ! Cliquez sur le bouton **Modifier** ci-dessous pour saisir vous-même vos informations.*`)
                .addFields(
                    { name: 'Guilde (Rôle)', value: parsedData.guildTag, inline: true },
                    { name: 'Pseudo Joueur', value: parsedData.playerName, inline: true },
                    { name: 'N° de Serveur', value: parsedData.serverNumber.trim() || 'Non détecté', inline: true }
                )
                .setFooter({ text: `Vérification pour ${message.author.username}`, iconURL: message.author.displayAvatarURL() });

            // Ligne de boutons interactifs
            const row = new ActionRowBuilder();

            if (parsedData.isGuildFound) {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`confirm_${message.author.id}`)
                        .setLabel('Confirmer')
                        .setStyle(ButtonStyle.Success)
                );
            }

            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`edit_${message.author.id}`)
                    .setLabel('Modifier / Compléter')
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
            const catchMsg = await message.channel.send(`❌ Une erreur est survenue lors de l'analyse de l'image de <@${message.author.id}>. Veuillez réessayer ou contacter un administrateur.`);
            
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
});

// ── Gestionnaire d'Interactions (Boutons & Modals) ──────────────────────────

client.on(Events.InteractionCreate, async interaction => {
    // 1. Clic sur un bouton
    if (interaction.isButton()) {
        const [action, targetUserId] = interaction.customId.split('_');

        // Sécurité : Seul l'auteur de l'image peut cliquer sur ses boutons
        if (interaction.user.id !== targetUserId) {
            return await interaction.reply({
                content: "❌ Seul l'utilisateur qui a envoyé l'image peut interagir avec ces boutons.",
                ephemeral: true
            });
        }

        const data = pendingVerifications.get(targetUserId);
        if (!data) {
            return await interaction.reply({
                content: "❌ Votre session de vérification a expiré ou est introuvable. Veuillez renvoyer votre capture d'écran.",
                ephemeral: true
            });
        }

        // Clic sur "Confirmer"
        if (action === 'confirm') {
            await interaction.deferReply({ ephemeral: true });

            try {
                await applyVerification(interaction.member, data.guildTag, data.playerName, data.serverNumber, interaction);
                pendingVerifications.delete(targetUserId);

                // Supprime la fiche de boutons du salon
                try { await interaction.message.delete(); } catch (e) {}
            } catch (err) {
                console.error("Verification application error:", err);
                let errMsg = "Une erreur de permission empêche le bot de modifier vos rôles ou votre pseudo.";
                if (err.code === 50013) {
                    errMsg += "\n*Note pour les admins : Assurez-vous que le rôle du bot est positionné plus haut que les rôles de guilde dans les paramètres du serveur.*";
                } else {
                    errMsg += `\nDétails : ${err.message}`;
                }
                await interaction.editReply({ content: `❌ ${errMsg}` });
            }
        }

        // Clic sur "Modifier"
        else if (action === 'edit') {
            // Construction du Modal (Formulaire contextuel)
            const modal = new ModalBuilder()
                .setCustomId(`modal_${targetUserId}`)
                .setTitle('Corriger vos informations');

            const guildInput = new TextInputBuilder()
                .setCustomId('guild_tag')
                .setLabel('TAG DE GUILDE (ex: GE)')
                .setStyle(TextInputStyle.Short)
                .setValue(data.guildTag.replace(/[\[\]]/g, '')) // Pré-remplit sans les crochets
                .setMinLength(2)
                .setMaxLength(10)
                .setPlaceholder('GE')
                .setRequired(true);

            const nameInput = new TextInputBuilder()
                .setCustomId('player_name')
                .setLabel('PSEUDO DANS LE JEU')
                .setStyle(TextInputStyle.Short)
                .setValue(data.playerName === 'NomInconnu' ? '' : data.playerName)
                .setMinLength(3)
                .setMaxLength(20)
                .setPlaceholder('Votre pseudo exact')
                .setRequired(true);

            const serverInput = new TextInputBuilder()
                .setCustomId('server_number')
                .setLabel('NUMÉRO DE SERVEUR (ex: 1061)')
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
                    content: "❌ Action non autorisée.",
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
                let errMsg = "Une erreur de permission empêche le bot de modifier vos rôles ou votre pseudo.";
                if (err.code === 50013) {
                    errMsg += "\n*Note pour les admins : Le rôle du bot doit être placé plus haut dans la liste des rôles.*";
                } else {
                    errMsg += `\nDétails : ${err.message}`;
                }
                await interaction.editReply({ content: `❌ ${errMsg}` });
            }
        }
    }
});

// ── Connexion du client Discord ──────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
