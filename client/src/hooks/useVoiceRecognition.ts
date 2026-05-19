import { useState, useCallback, useRef, useEffect } from 'react';

interface VoiceRecognitionOptions {
  onResult: (text: string) => void;
  onEnd?: () => void;
  continuous?: boolean;
  interimResults?: boolean;
}

export const useVoiceRecognition = ({ onResult, onEnd, continuous = false, interimResults = false }: VoiceRecognitionOptions) => {
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  
  // Use refs for callbacks to prevent re-initializing recognition on every render
  const onResultRef = useRef(onResult);
  const onEndRef = useRef(onEnd);
  
  useEffect(() => {
    onResultRef.current = onResult;
    onEndRef.current = onEnd;
  }, [onResult, onEnd]);

  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = continuous;
      recognition.interimResults = interimResults;
      recognition.lang = 'en-IN';

      recognition.onstart = () => setIsListening(true);
      recognition.onend = () => {
        setIsListening(false);
        if (onEndRef.current) onEndRef.current();
      };
      recognition.onresult = (event: any) => {
        const transcript = Array.from(event.results)
          .map((result: any) => result[0])
          .map((result: any) => result.transcript)
          .join('');
        if (onResultRef.current) onResultRef.current(transcript);
      };

      recognition.onerror = (event: any) => {
        console.error('Speech recognition error:', event.error);
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    }

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, [continuous, interimResults]);

  const startListening = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.start();
      } catch (e) {
        console.error('Speech recognition error:', e);
        // If already started, just ignore or stop first
        try { recognitionRef.current.stop(); } catch(err) {}
      }
    } else {
      alert('Speech Recognition is not supported in this browser. Please use Chrome.');
    }
  }, []);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
  }, []);

  return { isListening, startListening, stopListening, isSupported: !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) };
};
