require('dotenv').config();
const express = require('express');
const { ChimeSDKMeetingsClient, CreateMeetingCommand, CreateAttendeeCommand, StartMeetingTranscriptionCommand, StopMeetingTranscriptionCommand, DeleteMeetingCommand, GetMeetingCommand, ListMeetingsCommand } = require('@aws-sdk/client-chime-sdk-meetings');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { 
    TranscribeStreamingClient, 
    StartStreamTranscriptionCommand 
} = require('@aws-sdk/client-transcribe-streaming');

const app = express();
app.use(express.json());
app.use(cors({
    origin: 'http://localhost:5173', // URL de tu frontend (Vite usa 5173 por defecto)
    methods: ['GET', 'POST', 'DELETE'], // Añadir DELETE a los métodos permitidos
    allowedHeaders: ['Content-Type']
}));

// Configurar Amazon Chime SDK Meetings
const chimeClient = new ChimeSDKMeetingsClient({ 
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// 🔹 Variable global para almacenar la reunión
let globalMeeting = null;
let lastMeetingCreationTime = null;
const MEETING_EXPIRY_MINUTES = 60; // Las reuniones expiran después de cierto tiempo

// Almacenar múltiples reuniones
let meetings = {};

// Endpoint para listar reuniones disponibles
app.get('/list-meetings', (req, res) => {
    try {
        const meetingList = Object.keys(meetings).map(meetingId => {
            const meeting = meetings[meetingId];
            
            // Verificar que el objeto Meeting existe antes de acceder a sus propiedades
            const externalMeetingId = meeting.Meeting && meeting.Meeting.ExternalMeetingId 
                ? meeting.Meeting.ExternalMeetingId 
                : 'Sin ID externo';
            
            return {
                meetingId,
                externalMeetingId,
                creationTime: meeting.creationTime,
                attendeeCount: Object.keys(meeting.attendees || {}).length,
                transcriptionEnabled: meeting.transcriptionEnabled || false
            };
        });
        
        res.json(meetingList);
    } catch (error) {
        console.error('Error al listar reuniones:', error);
        res.status(500).json({ error: 'Error al listar reuniones: ' + error.message });
    }
});

// Endpoint para unirse a una reunión
app.post('/join-meeting', async (req, res) => {
    try {
        const { meetingId, userId, userName } = req.body;
        
        if (!meetingId || !meetings[meetingId]) {
            return res.status(404).json({ error: 'Reunión no encontrada' });
        }
        
        // Verificar si el usuario ya está en la reunión
        if (meetings[meetingId].attendees[userId]) {
            // Crear una copia segura de la información para enviar al cliente
            const meetingInfo = {
                Meeting: meetings[meetingId].Meeting,
                meetingId: meetings[meetingId].meetingId,
                creationTime: meetings[meetingId].creationTime,
                transcriptionEnabled: meetings[meetingId].transcriptionEnabled
            };
            
            // Devolver la información existente sin referencias circulares
            return res.json({
                meetingInfo: meetingInfo,
                attendeeInfo: meetings[meetingId].attendees[userId].attendeeInfo,
                isCreator: userId === meetings[meetingId].creatorId
            });
        }
        
        // Crear un asistente en AWS Chime
        const createAttendeeCommand = new CreateAttendeeCommand({
            MeetingId: meetingId,
            ExternalUserId: userId
        });
        
        const attendeeResponse = await chimeClient.send(createAttendeeCommand);
        
        // Guardar la información del asistente sin crear referencias circulares
        meetings[meetingId].attendees[userId] = {
            userId,
            userName: userName || userId,
            joinTime: new Date().toISOString(),
            attendeeInfo: attendeeResponse.Attendee
        };
        
        // Crear una copia segura de la información para enviar al cliente
        const meetingInfo = {
            Meeting: meetings[meetingId].Meeting,
            meetingId: meetings[meetingId].meetingId,
            creationTime: meetings[meetingId].creationTime,
            transcriptionEnabled: meetings[meetingId].transcriptionEnabled
        };
        
        console.log(`✅ Usuario ${userId} unido a la reunión: ${meetingId}`);
        res.json({
            meetingInfo: meetingInfo,
            attendeeInfo: attendeeResponse.Attendee,
            isCreator: userId === meetings[meetingId].creatorId
        });
    } catch (error) {
        console.error('Error al unirse a la reunión:', error);
        res.status(500).json({ error: 'Error al unirse a la reunión: ' + error.message });
    }
});

// Endpoint para crear una reunión
app.post('/create-meeting', async (req, res) => {
    try {
        const { userId } = req.body; // Recibir el ID del usuario que crea la reunión
        
        // Crear la reunión en AWS Chime
        const createMeetingCommand = new CreateMeetingCommand({
            ClientRequestToken: uuidv4(),
            MediaRegion: 'us-east-1',
            ExternalMeetingId: uuidv4()
        });
        
        const meetingResponse = await chimeClient.send(createMeetingCommand);
        const meetingId = meetingResponse.Meeting.MeetingId;
        
        // Guardar la información de la reunión
        meetings[meetingId] = {
            meetingId,
            Meeting: meetingResponse.Meeting, // Guardar el objeto Meeting completo
            creationTime: new Date().toISOString(),
            attendees: {},
            transcriptionEnabled: false,
            creatorId: userId // Guardar el ID del creador
        };
        
        console.log(`✅ Reunión creada: ${meetingId}, Creador: ${userId}`);
        res.json({ meetingId });
    } catch (error) {
        console.error('Error al crear reunión:', error);
        res.status(500).json({ error: 'Error al crear reunión: ' + error.message });
    }
});

// Endpoint para iniciar transcripción
app.post('/start-transcription', async (req, res) => {
    try {
        const { meetingId, region, language } = req.body;
        
        if (!meetingId || !meetings[meetingId]) {
            return res.status(404).json({ error: 'Reunión no encontrada' });
        }
        
        console.log(`Iniciando transcripción para la reunión: ${meetingId}`);
        
        // Mapear el idioma solicitado a uno compatible con AWS Transcribe
        const languageMapping = {
            'es-ES': 'es-US',  // Mapear español de España a español de EE.UU.
            'es': 'es-US'      // Mapear español genérico a español de EE.UU.
        };
        
        const mappedLanguage = languageMapping[language] || language || 'es-US';
        
        // Configurar la transcripción con valores corregidos
        const startTranscriptionCommand = new StartMeetingTranscriptionCommand({
            MeetingId: meetingId,
            TranscriptionConfiguration: {
                EngineTranscribeSettings: {
                    LanguageCode: mappedLanguage,  // Usar el idioma mapeado
                    Region: region || process.env.AWS_REGION || 'us-east-1',
                    VocabularyFilterMethod: 'mask'  // En minúsculas
                }
            }
        });
        
        try {
            const transcriptionResponse = await chimeClient.send(startTranscriptionCommand);
            console.log('Respuesta de transcripción:', transcriptionResponse);
            
            // Marcar la reunión como con transcripción habilitada
            meetings[meetingId].transcriptionEnabled = true;
            meetings[meetingId].transcriptionMethod = 'aws';
            
            console.log(`✅ Transcripción iniciada para la reunión: ${meetingId}`);
            res.json({ success: true, message: 'Transcripción iniciada correctamente' });
        } catch (error) {
            console.error('Error al iniciar transcripción:', error);
            
            // Verificar si es un error de permisos
            if (error.name === 'AccessDeniedException' || 
                error.message.includes('Access Denied') || 
                error.message.includes('not authorized')) {
                
                console.log('⚠️ Error de permisos detectado, intentando método alternativo...');
                
                // Marcar la reunión como con transcripción habilitada pero usando método alternativo
                meetings[meetingId].transcriptionEnabled = true;
                meetings[meetingId].transcriptionMethod = 'alternative';
                
                return res.status(403).json({ 
                    error: 'Error de permisos al iniciar transcripción', 
                    details: error.message,
                    alternativeAvailable: true,
                    message: 'Se ha activado la transcripción alternativa debido a problemas de permisos'
                });
            }
            
            throw error;
        }
    } catch (error) {
        console.error('Error al iniciar transcripción:', error);
        res.status(500).json({ error: 'Error al iniciar transcripción: ' + error.message });
    }
});

// Endpoint para detener transcripción
app.post('/stop-transcription', async (req, res) => {
    try {
        const { meetingId } = req.body;
        
        if (!meetingId || !meetings[meetingId]) {
            return res.status(404).json({ error: 'Reunión no encontrada' });
        }
        
        // Detener la transcripción
        const stopTranscriptionCommand = new StopMeetingTranscriptionCommand({
            MeetingId: meetingId
        });
        
        await chimeClient.send(stopTranscriptionCommand);
        
        // Actualizar el estado de transcripción de la reunión
        meetings[meetingId].transcriptionEnabled = false;
        
        console.log(`✅ Transcripción detenida para la reunión: ${meetingId}`);
        res.json({ success: true, message: 'Transcripción detenida' });
    } catch (error) {
        console.error('Error al detener transcripción:', error);
        res.status(500).json({ error: 'Error al detener transcripción: ' + error.message });
    }
});

// Endpoint para eliminar una reunión
app.delete('/delete-meeting/:meetingId', async (req, res) => {
    try {
        const { meetingId } = req.params;
        
        console.log(`Recibida solicitud para eliminar reunión: ${meetingId}`);
        
        if (!meetingId || !meetings[meetingId]) {
            console.log(`Reunión no encontrada: ${meetingId}`);
            return res.status(404).json({ error: 'Reunión no encontrada' });
        }
        
        // Intentar eliminar la reunión de AWS Chime
        try {
            const deleteMeetingCommand = new DeleteMeetingCommand({
                MeetingId: meetingId
            });
            
            await chimeClient.send(deleteMeetingCommand);
            console.log(`✅ Reunión eliminada en AWS Chime: ${meetingId}`);
        } catch (chimeError) {
            // Si la reunión ya no existe en Chime, ignoramos el error
            console.warn(`⚠️ No se pudo eliminar la reunión en AWS Chime: ${chimeError.message}`);
        }
        
        // Eliminar la reunión de nuestro registro local
        delete meetings[meetingId];
        console.log(`✅ Reunión eliminada de nuestro registro: ${meetingId}`);
        
        res.json({ success: true, message: 'Reunión eliminada correctamente' });
    } catch (error) {
        console.error('Error al eliminar reunión:', error);
        res.status(500).json({ error: 'Error al eliminar reunión: ' + error.message });
    }
});

// Endpoint alternativo para eliminar una reunión usando POST
app.post('/delete-meeting', async (req, res) => {
    try {
        const { meetingId } = req.body;
        
        console.log(`Recibida solicitud POST para eliminar reunión: ${meetingId}`);
        
        if (!meetingId || !meetings[meetingId]) {
            console.log(`Reunión no encontrada: ${meetingId}`);
            return res.status(404).json({ error: 'Reunión no encontrada' });
        }
        
        // Intentar eliminar la reunión de AWS Chime
        try {
            const deleteMeetingCommand = new DeleteMeetingCommand({
                MeetingId: meetingId
            });
            
            await chimeClient.send(deleteMeetingCommand);
            console.log(`✅ Reunión eliminada en AWS Chime: ${meetingId}`);
        } catch (chimeError) {
            // Si la reunión ya no existe en Chime, ignoramos el error
            console.warn(`⚠️ No se pudo eliminar la reunión en AWS Chime: ${chimeError.message}`);
        }
        
        // Eliminar la reunión de nuestro registro local
        delete meetings[meetingId];
        console.log(`✅ Reunión eliminada de nuestro registro: ${meetingId}`);
        
        res.json({ success: true, message: 'Reunión eliminada correctamente' });
    } catch (error) {
        console.error('Error al eliminar reunión:', error);
        res.status(500).json({ error: 'Error al eliminar reunión: ' + error.message });
    }
});

// Endpoint para verificar el estado de transcripción
app.get('/check-transcription/:meetingId', async (req, res) => {
    try {
        const { meetingId } = req.params;
        
        if (!meetingId || !meetings[meetingId]) {
            return res.status(404).json({ error: 'Reunión no encontrada' });
        }
        
        console.log(`Verificando estado de transcripción para la reunión: ${meetingId}`);
        
        // Verificar si la transcripción está habilitada en nuestro registro
        const isEnabledLocally = meetings[meetingId].transcriptionEnabled || false;
        
        // Intentar obtener el estado de la reunión desde AWS Chime
        let isEnabledOnChime = false;
        let chimeStatus = null;
        
        try {
            // Obtener información de la reunión
            const getMeetingCommand = new GetMeetingCommand({
                MeetingId: meetingId
            });
            
            const meetingInfo = await chimeClient.send(getMeetingCommand);
            chimeStatus = meetingInfo;
            
            // Verificar si la transcripción está activa
            // Nota: La forma exacta de verificar esto puede variar según la API
            isEnabledOnChime = meetingInfo.Meeting?.MeetingFeatures?.Transcription?.Status === 'Active';
        } catch (chimeError) {
            console.warn(`⚠️ No se pudo obtener información de la reunión desde AWS Chime: ${chimeError.message}`);
        }
        
        res.json({
            meetingId,
            transcriptionEnabled: {
                local: isEnabledLocally,
                chime: isEnabledOnChime
            },
            chimeStatus,
            serverTime: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error al verificar estado de transcripción:', error);
        res.status(500).json({ error: 'Error al verificar estado de transcripción: ' + error.message });
    }
});

// Endpoint alternativo para iniciar transcripción (sin usar el servicio integrado de Chime)
app.post('/start-transcription-alternative', async (req, res) => {
    try {
        const { meetingId } = req.body;
        
        if (!meetingId || !meetings[meetingId]) {
            return res.status(404).json({ error: 'Reunión no encontrada' });
        }
        
        console.log(`Iniciando transcripción alternativa para la reunión: ${meetingId}`);
        
        // Marcar la reunión como con transcripción habilitada
        meetings[meetingId].transcriptionEnabled = true;
        meetings[meetingId].transcriptionMethod = 'alternative';
        
        console.log(`✅ Transcripción alternativa iniciada para la reunión: ${meetingId}`);
        res.json({ 
            success: true, 
            message: 'Transcripción alternativa iniciada',
            note: 'Esta es una solución alternativa mientras se configuran los permisos correctos en AWS'
        });
    } catch (error) {
        console.error('Error al iniciar transcripción alternativa:', error);
        res.status(500).json({ error: 'Error al iniciar transcripción alternativa: ' + error.message });
    }
});

// Endpoint para verificar permisos de AWS
app.get('/verify-aws-permissions', async (req, res) => {
    try {
        console.log('Verificando permisos de AWS...');
        
        const permissionsCheck = {
            chimeSDKMeetings: {
                status: 'pending',
                details: null
            },
            transcribe: {
                status: 'pending',
                details: null
            }
        };
        
        // Verificar permisos de Chime SDK Meetings
        try {
            // Intentar una operación simple para verificar permisos
            const listMeetingsCommand = new ListMeetingsCommand({
                MaxResults: 1
            });
            
            await chimeClient.send(listMeetingsCommand);
            permissionsCheck.chimeSDKMeetings.status = 'success';
            permissionsCheck.chimeSDKMeetings.details = 'Permisos correctos para Chime SDK Meetings';
        } catch (error) {
            permissionsCheck.chimeSDKMeetings.status = 'error';
            permissionsCheck.chimeSDKMeetings.details = `Error: ${error.message}`;
            console.error('Error al verificar permisos de Chime SDK Meetings:', error);
        }
        
        // Verificar permisos de Transcribe
        try {
            // Crear cliente de Transcribe
            const transcribeClient = new TranscribeStreamingClient({ 
                region: process.env.AWS_REGION || 'us-east-1',
                credentials: {
                    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
                }
            });
            
            // Intentar una operación simple para verificar permisos
            const listLanguageModelsCommand = {
                MaxResults: 1
            };
            
            await transcribeClient.send(listLanguageModelsCommand);
            permissionsCheck.transcribe.status = 'success';
            permissionsCheck.transcribe.details = 'Permisos correctos para Transcribe';
        } catch (error) {
            permissionsCheck.transcribe.status = 'error';
            permissionsCheck.transcribe.details = `Error: ${error.message}`;
            console.error('Error al verificar permisos de Transcribe:', error);
        }
        
        // Verificar si hay errores específicos relacionados con permisos
        const hasPermissionIssues = 
            permissionsCheck.chimeSDKMeetings.status === 'error' && 
            permissionsCheck.chimeSDKMeetings.details.includes('AccessDenied') ||
            permissionsCheck.transcribe.status === 'error' && 
            permissionsCheck.transcribe.details.includes('AccessDenied');
        
        res.json({
            permissionsCheck,
            hasPermissionIssues,
            recommendations: hasPermissionIssues ? [
                'Verifica que las credenciales de AWS sean correctas',
                'Asegúrate de que el usuario de IAM tenga los permisos necesarios para Chime SDK Meetings y Transcribe',
                'Considera usar la transcripción alternativa mientras se resuelven los problemas de permisos'
            ] : []
        });
    } catch (error) {
        console.error('Error al verificar permisos de AWS:', error);
        res.status(500).json({ error: 'Error al verificar permisos de AWS: ' + error.message });
    }
});

// Función para limpiar reuniones expiradas (ejecutar periódicamente)
async function cleanupExpiredMeetings() {
    const now = Date.now();
    const EXPIRY_MS = 60 * 60 * 1000; // 1 hora en milisegundos
    
    for (const meetingId of Object.keys(meetings)) {
        if (now - meetings[meetingId].creationTime > EXPIRY_MS) {
            console.log(`🧹 Eliminando reunión expirada: ${meetingId}`);
            
            // Intentar eliminar la reunión de AWS Chime
            try {
                const deleteMeetingCommand = new DeleteMeetingCommand({
                    MeetingId: meetingId
                });
                
                await chimeClient.send(deleteMeetingCommand);
                console.log(`✅ Reunión expirada eliminada en AWS Chime: ${meetingId}`);
            } catch (error) {
                console.warn(`⚠️ No se pudo eliminar la reunión expirada en AWS Chime: ${error.message}`);
            }
            
            // Eliminar la reunión de nuestro registro local
            delete meetings[meetingId];
        }
    }
}

// Ejecutar limpieza cada 15 minutos
setInterval(cleanupExpiredMeetings, 15 * 60 * 1000);

// Iniciar servidor
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en el puerto ${PORT}`);
});
