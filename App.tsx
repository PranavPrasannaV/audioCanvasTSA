import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Chat, Part } from '@google/genai';
import { useCanvas, canvasReducer } from './hooks/useCanvas';
import CanvasBoard, { CanvasBoardHandle } from './components/CanvasBoard';
import { GeminiLiveService, drawShapeTool, addTextTool, removeElementTool, clearBoardTool, SYSTEM_INSTRUCTION } from './services/geminiLive';
import { ConnectionStatus, ChatMessage, CanvasElement, CanvasAction } from './types';
import { Mic, Square, Type as TypeIcon, Trash2, Users, RefreshCcw, Send, MessageSquare, Loader2, Eye, Wrench } from 'lucide-react';

const App: React.FC = () => {
  const { elements, addElement, clearCanvas, setElements, removeElement } = useCanvas();
  
  // Ref to track latest elements for tool handlers to avoid stale closures in Live Service callbacks
  const elementsRef = useRef(elements);
  useEffect(() => { elementsRef.current = elements; }, [elements]);

  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isChatOpen, setIsChatOpen] = useState(true);
  const [textChatSession, setTextChatSession] = useState<Chat | null>(null);
  
  // New state to track the agentic loop phase
  const [processingPhase, setProcessingPhase] = useState<'idle' | 'generating' | 'verifying' | 'fixing'>('idle');
  
  // Draft state for hidden verification
  const [draftElements, setDraftElements] = useState<CanvasElement[] | null>(null);
  
  const canvasRef = useRef<CanvasBoardHandle>(null);
  const draftCanvasRef = useRef<CanvasBoardHandle>(null);
  const serviceRef = useRef<GeminiLiveService | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, processingPhase]);

  // Helper to map tools to actions
  // Requires current elements list to handle 'remove_element' distance calculation
  const mapToolToAction = (name: string, args: any, currentElements: CanvasElement[]): CanvasAction | null => {
      switch (name) {
          case 'draw_shape':
            return {
              type: 'ADD_ELEMENT',
              payload: {
                id: crypto.randomUUID(),
                type: args.type,
                x: args.x,
                y: args.y,
                width: args.type === 'rect' || args.type === 'triangle' ? args.size : undefined,
                height: args.type === 'rect' ? args.size : undefined, 
                radius: args.type === 'circle' ? args.size / 2 : undefined,
                fill: args.color,
              }
            };
          case 'add_text':
            return {
              type: 'ADD_ELEMENT',
              payload: {
                id: crypto.randomUUID(),
                type: 'text',
                x: args.x,
                y: args.y,
                text: args.text,
                fill: args.color || 'black',
                fontSize: args.fontSize || 5,
              }
            };
          case 'remove_element': {
             // Find closest element
             let closestId = null;
             let minDist = 10000;
             const THRESHOLD = 20; // 20% of screen unit distance (generous to allow AI inaccuracy)
             
             for (const el of currentElements) {
                 const dx = el.x - args.x;
                 const dy = el.y - args.y;
                 const dist = Math.sqrt(dx*dx + dy*dy);
                 if (dist < minDist && dist < THRESHOLD) {
                     minDist = dist;
                     closestId = el.id;
                 }
             }
             
             if (closestId) {
                 return { type: 'REMOVE_ELEMENT', payload: closestId };
             }
             return null;
          }
          case 'clear_board':
            return { type: 'CLEAR' };
          default:
            return null;
      }
  };

  // Tool Handler shared between Live and Text modes
  // Uses elementsRef to always get the freshest state from the main canvas
  const handleTool = (name: string, args: any) => {
    console.log('Tool called (Live):', name, args);
    const action = mapToolToAction(name, args, elementsRef.current);
    if (action) {
        if (action.type === 'ADD_ELEMENT') addElement(action.payload);
        if (action.type === 'REMOVE_ELEMENT') removeElement(action.payload as string);
        if (action.type === 'CLEAR') clearCanvas();
    }
  };

  const handleTranscript = (message: ChatMessage) => {
    setMessages((prev) => [...prev, message]);
  };

  const toggleConnection = async () => {
    if (status === ConnectionStatus.CONNECTED || status === ConnectionStatus.CONNECTING) {
      await serviceRef.current?.disconnect();
      setStatus(ConnectionStatus.DISCONNECTED);
      serviceRef.current = null;
    } else {
      const apiKey = process.env.API_KEY;
      if (!apiKey) {
        alert('API Key not found in environment');
        return;
      }

      setStatus(ConnectionStatus.CONNECTING);
      try {
        const service = new GeminiLiveService(apiKey, handleTool, handleTranscript);
        serviceRef.current = service;
        
        await service.connect(async () => {
            return canvasRef.current?.getSnapshotBlob() || null;
        });
        
        setStatus(ConnectionStatus.CONNECTED);
        setMessages([]); // Clear chat on new session
      } catch (e) {
        console.error(e);
        setStatus(ConnectionStatus.ERROR);
        serviceRef.current = null;
      }
    }
  };

  const handleSendText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    
    const text = inputText.trim();
    setInputText('');
    
    setMessages(prev => [...prev, {
      id: crypto.randomUUID(),
      role: 'user',
      text: text,
      isFinal: true
    }]);

    if (status === ConnectionStatus.CONNECTED && serviceRef.current) {
        await serviceRef.current.sendText(text);
    } else {
        const apiKey = process.env.API_KEY;
        if (!apiKey) {
             console.error("API Key not found");
             return;
        }

        try {
            let chat = textChatSession;
            if (!chat) {
                const client = new GoogleGenAI({ apiKey });
                chat = client.chats.create({
                    model: 'gemini-3-flash-preview',
                    config: {
                        tools: [{functionDeclarations: [drawShapeTool, addTextTool, removeElementTool, clearBoardTool]}],
                        systemInstruction: SYSTEM_INSTRUCTION
                    }
                });
                setTextChatSession(chat);
            }

            // Phase 1: Generating
            setProcessingPhase('generating');
            
            // Initialize Draft Mode
            let currentDraft = [...elements];
            setDraftElements(currentDraft);

            let response = await chat.sendMessage({ message: text });
            
            let iterations = 0;
            const MAX_ITERATIONS = 5;

            // Agentic Loop
            while (response.functionCalls && response.functionCalls.length > 0 && iterations < MAX_ITERATIONS) {
                iterations++;
                
                // 1. Execute Tools on DRAFT state
                const toolResponses: Part[] = [];
                for (const fc of response.functionCalls) {
                     const action = mapToolToAction(fc.name, fc.args, currentDraft);
                     if (action) {
                         const newState = canvasReducer({ elements: currentDraft }, action);
                         currentDraft = newState.elements;
                     }
                     
                     toolResponses.push({
                        functionResponse: {
                            id: fc.id,
                            name: fc.name,
                            response: { result: 'success' }
                        }
                     });
                }
                
                // Update the hidden draft canvas
                setDraftElements(currentDraft);

                // Phase 2 or 3: Verifying or Fixing
                if (iterations === 1) {
                    setProcessingPhase('verifying');
                } else {
                    setProcessingPhase('fixing');
                }
                
                // 2. Capture Visual State from DRAFT Canvas
                // Wait briefly for React/DOM to render new elements on the hidden canvas
                await new Promise(resolve => setTimeout(resolve, 800));
                
                // Use draftCanvasRef instead of main canvasRef
                const blob = await draftCanvasRef.current?.getSnapshotBlob();
                let imagePart: Part | null = null;
                
                if (blob) {
                    const base64 = await new Promise<string>((resolve) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
                        reader.readAsDataURL(blob);
                    });
                    imagePart = {
                        inlineData: {
                            mimeType: 'image/jpeg',
                            data: base64
                        }
                    };
                }

                // 3. Send Tool Outputs + Image for Verification
                const parts: Part[] = [...toolResponses];
                
                if (imagePart) {
                    // Start with basic verification
                    let verificationPrompt = "Here is the visual result. Critically evaluate if it matches the request.";
                    
                    // ESCALATION STRATEGY:
                    // If we are past the first correction (iterations >= 2), the AI is struggling.
                    // We simply forbid drawing new things until it cleans up.
                    if (iterations >= 2) {
                        verificationPrompt += " CRITICAL: You have made multiple attempts. If the image is still wrong, do not attempt small tweaks. YOU MUST use 'remove_element' to delete the specific wrong items OR 'clear_board' to start over, then redraw correctly. Do not simply draw over mistakes. DELETE THEM.";
                    } else {
                         verificationPrompt += " If correct, respond with text. If incorrect, call tools to fix (prioritize removing mistakes with 'remove_element' before redrawing).";
                    }

                    parts.push({ text: verificationPrompt });
                    parts.push(imagePart);
                }

                response = await chat.sendMessage({ message: parts });
            }

            // Loop Finished: Commit changes to real canvas
            if (currentDraft) {
                setElements(currentDraft);
            }

            // Final Text Response
            if (response.text) {
                 setMessages(prev => [...prev, {
                     id: crypto.randomUUID(),
                     role: 'model',
                     text: response.text,
                     isFinal: true
                 }]);
            }

        } catch (error) {
            console.error("Error sending text message:", error);
            setMessages(prev => [...prev, {
                id: crypto.randomUUID(),
                role: 'model',
                text: "Sorry, I encountered an error processing your request.",
                isFinal: true
            }]);
        } finally {
            setProcessingPhase('idle');
            setDraftElements(null);
        }
    }
  };

  useEffect(() => {
    return () => {
      serviceRef.current?.disconnect();
    };
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-900 text-slate-100 relative">
      {/* Hidden Draft Canvas for AI verification */}
      <div className="absolute top-0 left-0 w-full h-full -z-50 opacity-0 pointer-events-none overflow-hidden">
        {draftElements && (
             <div className="p-6 flex justify-center items-center w-full h-full">
                <div className="w-full max-w-5xl aspect-square md:aspect-[4/3] relative">
                    <CanvasBoard ref={draftCanvasRef} elements={draftElements} />
                </div>
            </div>
        )}
      </div>

      {/* Header */}
      <header className="h-16 border-b border-slate-700 flex items-center justify-between px-6 bg-slate-800/50 backdrop-blur-md z-10 shrink-0">
        <div className="flex items-center space-x-2">
            <div className="w-8 h-8 bg-gradient-to-tr from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                <span className="font-bold text-white text-lg">G</span>
            </div>
            <h1 className="text-xl font-bold tracking-tight">Gemini Voice Canvas</h1>
        </div>
        
        <div className="flex items-center space-x-4">
             <div className="flex items-center space-x-1.5 px-3 py-1 bg-slate-800 rounded-full border border-slate-600">
                <Users className="w-4 h-4 text-emerald-400" />
                <span className="text-xs font-medium text-slate-300">Collab Mode Active</span>
            </div>
            
            <button
              onClick={() => setIsChatOpen(!isChatOpen)}
              className={`p-2 rounded-full transition-colors ${isChatOpen ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              <MessageSquare className="w-5 h-5" />
            </button>

            <button
              onClick={toggleConnection}
              className={`flex items-center space-x-2 px-4 py-2 rounded-full font-medium transition-all ${
                status === ConnectionStatus.CONNECTED
                  ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/50'
                  : status === ConnectionStatus.CONNECTING 
                    ? 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/50'
                    : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/20'
              }`}
            >
              {status === ConnectionStatus.CONNECTED ? (
                <>
                  <Square className="w-4 h-4 fill-current" />
                  <span>Stop Session</span>
                </>
              ) : status === ConnectionStatus.CONNECTING ? (
                 <>
                  <RefreshCcw className="w-4 h-4 animate-spin" />
                  <span>Connecting...</span>
                </>
              ) : (
                <>
                  <Mic className="w-4 h-4" />
                  <span>Start Live Session</span>
                </>
              )}
            </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden relative">
        {/* Canvas Area */}
        <div className="flex-1 p-6 flex justify-center items-center overflow-hidden relative">
            <div className="w-full max-w-5xl aspect-square md:aspect-[4/3] relative shadow-2xl rounded-xl border border-slate-700/50 bg-slate-800">
                <CanvasBoard ref={canvasRef} elements={elements} />
                
                {/* Overlay Status */}
                {status === ConnectionStatus.CONNECTED && (
                    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 bg-black/70 backdrop-blur-md rounded-full text-sm text-white border border-white/10 flex items-center space-x-3 pointer-events-none">
                        <span className="relative flex h-3 w-3">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
                        </span>
                        <span>Gemini is listening & watching...</span>
                    </div>
                )}
            </div>
            
             {/* Floating Toolbar */}
            <div className="absolute left-6 top-1/2 -translate-y-1/2 flex flex-col space-y-2 bg-slate-800/80 backdrop-blur border border-slate-700 p-2 rounded-xl">
                 <div className="p-2 hover:bg-slate-700 rounded-lg transition-colors group relative">
                    <Square className="w-5 h-5 text-slate-300" />
                    <span className="absolute left-full ml-2 px-2 py-1 bg-black text-xs rounded opacity-0 group-hover:opacity-100 whitespace-nowrap">Shapes</span>
                 </div>
                 <div className="p-2 hover:bg-slate-700 rounded-lg transition-colors group relative">
                    <TypeIcon className="w-5 h-5 text-slate-300" />
                    <span className="absolute left-full ml-2 px-2 py-1 bg-black text-xs rounded opacity-0 group-hover:opacity-100 whitespace-nowrap">Text</span>
                 </div>
                 <div className="h-px bg-slate-700 my-1" />
                 <div 
                    className="p-2 hover:bg-red-900/30 text-red-400 rounded-lg transition-colors cursor-pointer group relative"
                    onClick={clearCanvas}
                 >
                    <Trash2 className="w-5 h-5" />
                     <span className="absolute left-full ml-2 px-2 py-1 bg-black text-xs rounded opacity-0 group-hover:opacity-100 whitespace-nowrap">Clear</span>
                 </div>
            </div>
        </div>

        {/* Chat Sidebar */}
        {isChatOpen && (
           <div className="w-80 bg-slate-800 border-l border-slate-700 flex flex-col shrink-0 transition-all">
              <div className="p-4 border-b border-slate-700 font-medium text-slate-300 flex justify-between items-center">
                 <span>Conversation</span>
              </div>
              
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                 {messages.length === 0 && (
                    <div className="text-center text-slate-500 text-sm mt-10">
                       <p>Start the session to chat or speak.</p>
                       <p className="mt-2 text-xs">Say "Draw a blue circle" or type it below.</p>
                    </div>
                 )}
                 {messages.map((msg) => (
                    <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                       <div className={`max-w-[85%] px-3 py-2 rounded-xl text-sm ${
                          msg.role === 'user' 
                             ? 'bg-blue-600 text-white rounded-br-none' 
                             : 'bg-slate-700 text-slate-200 rounded-bl-none'
                       }`}>
                          {msg.text}
                       </div>
                       <span className="text-[10px] text-slate-500 mt-1 capitalize">{msg.role}</span>
                    </div>
                 ))}
                 
                 {/* Processing Status Indicator */}
                 {processingPhase !== 'idle' && (
                    <div className="flex items-center space-x-3 px-3 py-2 bg-slate-700/30 rounded-lg border border-slate-600/50 animate-in fade-in slide-in-from-bottom-2 duration-300">
                        <div className={`p-1.5 rounded-full flex items-center justify-center shadow-lg shadow-black/20 ${
                            processingPhase === 'fixing' ? 'bg-orange-500/20 text-orange-400 ring-1 ring-orange-500/40' :
                            processingPhase === 'verifying' ? 'bg-purple-500/20 text-purple-400 ring-1 ring-purple-500/40' :
                            'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/40'
                        }`}>
                            {processingPhase === 'generating' && <Loader2 className="w-4 h-4 animate-spin" />}
                            {processingPhase === 'verifying' && <Eye className="w-4 h-4 animate-pulse" />}
                            {processingPhase === 'fixing' && <Wrench className="w-4 h-4 animate-bounce" />}
                        </div>
                        <div className="flex flex-col">
                            <span className="text-xs font-semibold text-slate-200 uppercase tracking-wider leading-none mb-0.5">
                                {processingPhase}
                            </span>
                            <span className="text-[10px] text-slate-400 leading-tight">
                                {processingPhase === 'generating' && "Creating initial design..."}
                                {processingPhase === 'verifying' && "Checking visual accuracy..."}
                                {processingPhase === 'fixing' && "Correcting mistakes..."}
                            </span>
                        </div>
                    </div>
                 )}

                 <div ref={messagesEndRef} />
              </div>

              <div className="p-4 border-t border-slate-700 bg-slate-800">
                 <form onSubmit={handleSendText} className="relative">
                    <input
                       type="text"
                       value={inputText}
                       onChange={(e) => setInputText(e.target.value)}
                       placeholder={status === ConnectionStatus.CONNECTED ? "Type a command..." : "Type to chat or draw..."}
                       disabled={processingPhase !== 'idle'}
                       className="w-full bg-slate-900 border border-slate-600 rounded-full pl-4 pr-10 py-2.5 text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50 text-white placeholder-slate-500"
                    />
                    <button 
                       type="submit"
                       disabled={!inputText.trim() || processingPhase !== 'idle'}
                       className="absolute right-1.5 top-1.5 p-1.5 bg-blue-600 text-white rounded-full hover:bg-blue-500 disabled:opacity-50 transition-all"
                    >
                       <Send className="w-3 h-3" />
                    </button>
                 </form>
              </div>
           </div>
        )}
      </main>
    </div>
  );
};

export default App;
