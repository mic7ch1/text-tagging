import { useState, useEffect, type FC, type ChangeEvent, type DragEvent, useRef } from 'react';
import ReactCrop, { type Crop } from 'react-image-crop';
import { Stage, Layer, Image as KonvaImage, Rect as KonvaRect, Transformer } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import 'react-image-crop/dist/ReactCrop.css';
import './App.css';
import { loadCv } from './cv-loader';
import { useTheme } from './theme-provider';

type BoxClass = 'Man' | 'Chi' | 'Frame';

interface BoundingBox {
    x: number;
    y: number;
    w: number;
    h: number;
    area: number;
    id: number;
    cluster?: number;
    centroidX?: number;
    text?: string;
    class?: BoxClass; // Class tag for YOLO training
}

interface PreprocessSettings {
  adaptiveBlockSize: number;
  adaptiveC: number;
  denoiseCloseKernelWidth: number;
  denoiseOpenKernelWidth: number;
}

interface UploadPanelProps {
  onFileSelect: (file: File) => void;
}

interface SettingsPanelProps {
  preprocessSettings: PreprocessSettings;
  onPreprocessSettingsChange: (settings: PreprocessSettings) => void;
  textDetectionSettings: TextDetectionSettings;
  onTextDetectionSettingsChange: (settings: TextDetectionSettings) => void;
  isExpanded: boolean;
  onToggle: () => void;
  onReset: () => void;
}

interface TextDetectionSettings {
  detectDilateKernelWidth: number;
  detectAreaLowerBound: number;
  detectAreaUpperBound: number;
  detectAspRatioBound: number;
  overlapAreaLowerBound: number;
  overlapAspRatioBound: number;
  overlapUpperTolerance: number;
  overlapLowerTolerance: number;
  overlapLeftTolerance: number;
  overlapRightTolerance: number;
  cropPaddingWidth: number;
}

const steps = ['Settings & Crop', 'Fine-tune', 'Tag Classes', 'Export Coordinates'];

interface AppStepperProps {
  currentStep: number;
  maxCompletedStep: number;
  onStepClick: (stepIndex: number) => void;
}

const AppStepper: FC<AppStepperProps> = ({ currentStep, maxCompletedStep, onStepClick }) => (
    <div className="stepper">
        {steps.map((step, index) => {
            const isClickable = index <= maxCompletedStep;
            return (
                <div
                    key={step}
                    className={`step ${index <= currentStep ? 'active' : ''} ${isClickable ? 'clickable' : ''}`}
                    onClick={() => isClickable && onStepClick(index)}
                >
                    <div className="step-label">{step}</div>
                    <div className="step-bar-container">
                        {index <= currentStep &&
                            <div className="step-bar-filled" style={{ animation: index === currentStep ? 'fill 0.3s linear' : 'none' }} />
                        }
                    </div>
                </div>
            )
        })}
    </div>
);

const AppControls: FC<{
  currentStep: number;
  onBack: () => void;
  onNext: () => void;
}> = ({ currentStep, onBack, onNext }) => (
  <footer className="footer">
    <button onClick={onBack} disabled={currentStep === 0} className="nav-button">
      Back
    </button>
    {currentStep === steps.length - 1 ? (
      <button onClick={() => window.location.reload()} className="nav-button">
        Start Over
      </button>
    ) : (
      <button onClick={onNext} className="nav-button">
        Next
      </button>
    )}
  </footer>
);

const App: FC = () => {
  const [cvReady, setCvReady] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [maxCompletedStep, setMaxCompletedStep] = useState(0);
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [originalFileName, setOriginalFileName] = useState<string>('');
  const [crop, setCrop] = useState<Crop | undefined>(() => {
    const saved = localStorage.getItem('crop');
    return saved ? JSON.parse(saved) : undefined;
  });
  const [preprocessedImage, setPreprocessedImage] = useState<string | null>(null);
  const [preprocessSettings, setPreprocessSettings] = useState<PreprocessSettings>(() => {
    const saved = localStorage.getItem('preprocessSettings');
    return saved ? JSON.parse(saved) : {
      adaptiveBlockSize: 101,
      adaptiveC: 30,
      denoiseCloseKernelWidth: 1,
      denoiseOpenKernelWidth: 2,
    };
  });
  const [textDetectionSettings, setTextDetectionSettings] = useState<TextDetectionSettings>(() => {
    const saved = localStorage.getItem('textDetectionSettings');
    return saved ? JSON.parse(saved) : {
      detectDilateKernelWidth: 2,
      detectAreaLowerBound: 500,
      detectAreaUpperBound: 15000,
      detectAspRatioBound: 5,
      overlapAreaLowerBound: 100,
      overlapAspRatioBound: 10,
      overlapUpperTolerance: 3,
      overlapLowerTolerance: 3,
      overlapLeftTolerance: 7,
      overlapRightTolerance: 7,
      cropPaddingWidth: 8,
    };
  });
  const [textDetectionImage, setTextDetectionImage] = useState<string | null>(null);
  const [finalBoundingBoxes, setFinalBoundingBoxes] = useState<BoundingBox[]>([]);
  const [excludedIndices] = useState<number[]>([]);
  const fineTunePanelRef = useRef<HTMLDivElement>(null);
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const contentAreaRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const imgRef = useRef<HTMLImageElement>(null);
  const { theme, setTheme } = useTheme();
  const [isSettingsExpanded, setIsSettingsExpanded] = useState(false);
  const [isAutoNavigating, setIsAutoNavigating] = useState(false);
  const [selectedBoxIdsForTagging, setSelectedBoxIdsForTagging] = useState<number[]>([]);


  useEffect(() => {
    localStorage.setItem('preprocessSettings', JSON.stringify(preprocessSettings));
  }, [preprocessSettings]);

  useEffect(() => {
    localStorage.setItem('textDetectionSettings', JSON.stringify(textDetectionSettings));
  }, [textDetectionSettings]);

  useEffect(() => {
    if (crop) {
      localStorage.setItem('crop', JSON.stringify(crop));
    } else {
      localStorage.removeItem('crop');
    }
  }, [crop]);

  useEffect(() => {
    if (!isAutoNavigating) return;

    if (currentStep === 1) {
      // We've automatically navigated forward, now go back.
      setCurrentStep(0);
    } else if (currentStep === 0) {
      // We've automatically navigated back, now go forward for the final time.
      setCurrentStep(1);
      setIsAutoNavigating(false); // End the sequence
    }
  }, [currentStep, isAutoNavigating]);

  useEffect(() => {
    loadCv().then(() => setCvReady(true));
  }, []);

  useEffect(() => {
    if (!sourceImage) {
        return;
    }

    const updatePreview = async () => {
        const preprocessed = await performPreprocessing(sourceImage);
        if (preprocessed) {
            setImage(preprocessed);
        }
    };

    updatePreview();
  }, [sourceImage, preprocessSettings]);

  useEffect(() => {
    if (currentStep > 0 && contentAreaRef.current) {
        setTimeout(() => {
            contentAreaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
    }
  }, [currentStep]);

  useEffect(() => {
    const left = leftPanelRef.current;
    const right = fineTunePanelRef.current;

    if (!left || !right) return;

    if (currentStep === 0) {
        left.style.minHeight = '';
        return;
    }

    const observer = new ResizeObserver(() => {
        const rightHeight = right.offsetHeight;
        if (left.style.minHeight !== `${rightHeight}px`) {
            left.style.minHeight = `${rightHeight}px`;
        }
    });
    
    observer.observe(right);
    
    // Set initial height
    const rightHeight = right.offsetHeight;
    left.style.minHeight = `${rightHeight}px`;

    return () => {
        observer.disconnect();
        if(left) {
           left.style.minHeight = '';
        }
    };
  }, [currentStep, image, preprocessedImage, textDetectionImage]);

  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      for (let entry of entries) {
        const { width, height } = entry.contentRect;
        setStageSize({ width, height });
      }
    });

    if (fineTunePanelRef.current) {
      observer.observe(fineTunePanelRef.current);
    }

    return () => {
      observer.disconnect();
    };
  }, [currentStep]); // Rerun when step changes to attach observer at the right time

  const clearStateAfter = (stepIndex: number) => {
    if (stepIndex < 3) {
        setSelectedBoxIdsForTagging([]);
    }
    if (stepIndex < 2) {
        setTextDetectionImage(null);
        setFinalBoundingBoxes([]);
    }
    if (stepIndex < 1) {
        setPreprocessedImage(null);
    }
  }

  const handleBoxClassChange = (boxIds: number[], boxClass: BoxClass | undefined) => {
    setFinalBoundingBoxes(prevBoxes =>
      prevBoxes.map(box =>
        boxIds.includes(box.id) ? { ...box, class: boxClass } : box
      )
    );
    // Clear selection after tagging
    setSelectedBoxIdsForTagging([]);
  };

  const handleResetSettings = () => {
    const defaultPreprocessSettings = {
      adaptiveBlockSize: 101,
      adaptiveC: 30,
      denoiseCloseKernelWidth: 1,
      denoiseOpenKernelWidth: 2,
    };
    const defaultTextDetectionSettings = {
      detectDilateKernelWidth: 2,
      detectAreaLowerBound: 500,
      detectAreaUpperBound: 15000,
      detectAspRatioBound: 5,
      overlapAreaLowerBound: 100,
      overlapAspRatioBound: 10,
      overlapUpperTolerance: 3,
      overlapLowerTolerance: 3,
      overlapLeftTolerance: 7,
      overlapRightTolerance: 7,
      cropPaddingWidth: 8,
    };
    
    setPreprocessSettings(defaultPreprocessSettings);
    setTextDetectionSettings(defaultTextDetectionSettings);
    setCrop(undefined);

    localStorage.removeItem('preprocessSettings');
    localStorage.removeItem('textDetectionSettings');
    localStorage.removeItem('crop');
  };

  const handleNext = async () => {
    if (currentStep === 0) { // Moving from Settings & Crop to Fine-tune
      console.log("handleNext: Starting step 0 processing...");
      const cropped = await performCrop();
      if (cropped) {
        console.log("handleNext: Crop successful.");
        const preprocessed = await performPreprocessing(cropped);
        if (preprocessed) {
          setPreprocessedImage(preprocessed);
          console.log("handleNext: Preprocessing successful.");
          const { detectionImage, boxes } = await performTextDetection(preprocessed);
          console.log(`handleNext: Text detection returned ${boxes.length} boxes.`);
          setTextDetectionImage(detectionImage);
          setFinalBoundingBoxes(boxes);
          
          // Start the automatic navigation sequence
          setIsAutoNavigating(true);
          setCurrentStep(1);

        } else {
          console.error("handleNext: Preprocessing failed, aborting.");
        }
      } else {
        console.error("handleNext: Crop failed, aborting.");
      }
    } else if (currentStep === 1) { // Moving from Fine-tune to Tag Classes
      if (isAutoNavigating) return; // Prevent user clicks during auto-navigation
      const nextStep = Math.min(currentStep + 1, steps.length - 1);
      setCurrentStep(nextStep);
      setMaxCompletedStep(Math.max(maxCompletedStep, nextStep));
    } else if (currentStep === 2) { // Moving from Tag Classes to Export Coordinates
      const nextStep = Math.min(currentStep + 1, steps.length - 1);
      setCurrentStep(nextStep);
      setMaxCompletedStep(Math.max(maxCompletedStep, nextStep));
    }
  };

  const handleBack = () => {
    const targetStep = currentStep - 1;
    if (targetStep < 0) return;
    clearStateAfter(targetStep);
    setCurrentStep(targetStep);
  };

  const handleStepClick = (stepIndex: number) => {
    if (stepIndex > maxCompletedStep || stepIndex === currentStep) {
      return;
    }
    if (stepIndex < currentStep) {
      clearStateAfter(stepIndex);
    }
    setCurrentStep(stepIndex);
  };
  
  const handleFileSelect = (file: File) => {
    if (file) {
      setOriginalFileName(file.name);
      const reader = new FileReader();
      reader.onload = async (e) => {
        if (e.target && typeof e.target.result === 'string') {
          const cv = await loadCv();

          // 1. Load image into an HTML Image Element
          const originalImage = new Image();
          originalImage.src = e.target.result;
          await new Promise(resolve => { originalImage.onload = resolve });

          // 2. Read into OpenCV Mat
          const src = cv.imread(originalImage);

          // 3. Pad to aspect ratio (2:3)
          const h = src.rows;
          const w = src.cols;
          const targetAspectRatio = 2.0 / 3.0;
          let padded = src;
          let top = 0, bottom = 0, left = 0, right = 0;

          if ((w / h) > targetAspectRatio) {
            // Image is too wide, adjust height
            const targetHeight = Math.round(w / targetAspectRatio);
            top = Math.floor((targetHeight - h) / 2);
            bottom = targetHeight - h - top;
          } else {
            // Image is too tall, adjust width
            const targetWidth = Math.round(h * targetAspectRatio);
            left = Math.floor((targetWidth - w) / 2);
            right = targetWidth - w - left;
          }
          
          if(top > 0 || bottom > 0 || left > 0 || right > 0) {
            const s = new cv.Scalar(255, 255, 255, 255);
            padded = new cv.Mat();
            cv.copyMakeBorder(src, padded, top, bottom, left, right, cv.BORDER_CONSTANT, s);
            src.delete(); // clean up original src
          }
          
          // 4. Resize to width 2000px
          const targetWidth = 2000;
          const resized = new cv.Mat();
          const dsize = new cv.Size(targetWidth, Math.round(padded.rows * targetWidth / padded.cols));
          cv.resize(padded, resized, dsize, 0, 0, cv.INTER_AREA);
          padded.delete();

          // 5. Convert final mat to data URL and set state
          const canvas = document.createElement('canvas');
          cv.imshow(canvas, resized);
          setSourceImage(canvas.toDataURL('image/jpeg'));
          resized.delete();
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const performCrop = async (): Promise<string | null> => {
    if (!sourceImage || !imgRef.current) {
      return null;
    }
  
    const cv = await loadCv();
    
    const originalImage = new Image();
    originalImage.src = sourceImage;
    await new Promise(resolve => { originalImage.onload = resolve });
  
    const src = cv.imread(originalImage);
  
    // If no crop is selected, or crop is empty, use the full source image.
    if (!crop || !crop.width || !crop.height) {
      const canvas = document.createElement('canvas');
      cv.imshow(canvas, src);
      const dataUrl = canvas.toDataURL('image/jpeg');
      src.delete();
      return dataUrl;
    }
  
    // If a crop is selected, perform the crop on the source image.
    const scaleX = originalImage.naturalWidth / imgRef.current.width;
    const scaleY = originalImage.naturalHeight / imgRef.current.height;
  
    const rect = new cv.Rect(crop.x * scaleX, crop.y * scaleY, crop.width * scaleX, crop.height * scaleY);
    
    // Ensure the rectangle is within the image bounds
    if (rect.x < 0) rect.x = 0;
    if (rect.y < 0) rect.y = 0;
    if (rect.x + rect.width > src.cols) rect.width = src.cols - rect.x;
    if (rect.y + rect.height > src.rows) rect.height = src.rows - rect.y;

    if (rect.width <= 0 || rect.height <= 0) {
        src.delete();
        return null; // Invalid crop dimensions
    }

    const croppedMat = src.roi(rect);
  
    const canvas = document.createElement('canvas');
    cv.imshow(canvas, croppedMat);
    const dataUrl = canvas.toDataURL('image/jpeg');
  
    src.delete();
    croppedMat.delete();
    return dataUrl;
  };

  const performPreprocessing = async (imageUrl: string): Promise<string | null> => {
    if (!imageUrl) {
      console.log("Preprocessing skipped: no cropped image.");
      return null;
    }
    console.log("Starting preprocessing...");

    try {
      const cv = await loadCv();
      
      const imageElement = new Image();
      imageElement.src = imageUrl;
      await new Promise((resolve, reject) => {
        imageElement.onload = resolve;
        imageElement.onerror = reject;
      });
      console.log("Image loaded for preprocessing.");

      const src = cv.imread(imageElement);
      const gray = new cv.Mat();
      const bin = new cv.Mat();
      const imgOpen = new cv.Mat();
      const imgDenoise = new cv.Mat();

      // ** THE FIX: Convert to Grayscale First **
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

      const blockSize = preprocessSettings.adaptiveBlockSize % 2 === 0 ? preprocessSettings.adaptiveBlockSize + 1 : preprocessSettings.adaptiveBlockSize;
      
      console.log("Applying adaptive threshold...");
      cv.adaptiveThreshold(gray, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, blockSize, preprocessSettings.adaptiveC);

      console.log("Applying morphological operations...");
      const openKernel = cv.Mat.ones(preprocessSettings.denoiseOpenKernelWidth, preprocessSettings.denoiseOpenKernelWidth, cv.CV_8U);
      const closeKernel = cv.Mat.ones(preprocessSettings.denoiseCloseKernelWidth, preprocessSettings.denoiseCloseKernelWidth, cv.CV_8U);
      cv.morphologyEx(bin, imgOpen, cv.MORPH_OPEN, openKernel);
      cv.morphologyEx(imgOpen, imgDenoise, cv.MORPH_CLOSE, closeKernel);

      const canvas = document.createElement('canvas');
      cv.imshow(canvas, imgDenoise);
      console.log("Preprocessing complete, setting image state.");
      const dataUrl = canvas.toDataURL('image/jpeg');
      
      src.delete(); gray.delete(); bin.delete(); imgOpen.delete(); imgDenoise.delete(); openKernel.delete(); closeKernel.delete();
      return dataUrl;
    } catch (error) {
      console.error("Error during preprocessing:", error);
      return null;
    }
  }

  const performTextDetection = async (preprocessedImageUrl: string): Promise<{detectionImage: string | null, boxes: BoundingBox[]}> => {
    if (!preprocessedImageUrl) {
        console.log("Text detection skipped: no preprocessed image.");
        return { detectionImage: null, boxes: [] };
    }
    console.log("Starting text detection...");
    
    try {
        const cv = await loadCv();
        const imageElement = new Image();
        imageElement.src = preprocessedImageUrl;
        await new Promise((resolve, reject) => {
            imageElement.onload = resolve;
            imageElement.onerror = reject;
        });
        
        const src = cv.imread(imageElement);
        const gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

        const imgDenoise = new cv.Mat();
        cv.bitwise_not(gray, imgDenoise);

        const dilateKernel = cv.Mat.ones(textDetectionSettings.detectDilateKernelWidth, textDetectionSettings.detectDilateKernelWidth, cv.CV_8U);
        const imgDilate = new cv.Mat();
        cv.morphologyEx(imgDenoise, imgDilate, cv.MORPH_DILATE, dilateKernel);
        
        const labels = new cv.Mat();
        const stats = new cv.Mat();
        const centroids = new cv.Mat();
        const numLabels = cv.connectedComponentsWithStats(imgDilate, labels, stats, centroids, 8, cv.CV_32S);
        console.log(`Text detection: Found ${numLabels - 1} initial components.`);
        
        const allBoxes: BoundingBox[] = [];
        for (let i = 1; i < numLabels; i++) {
            allBoxes.push({
                x: stats.intAt(i, cv.CC_STAT_LEFT),
                y: stats.intAt(i, cv.CC_STAT_TOP),
                w: stats.intAt(i, cv.CC_STAT_WIDTH),
                h: stats.intAt(i, cv.CC_STAT_HEIGHT),
                area: stats.intAt(i, cv.CC_STAT_AREA),
                id: i,
            });
        }
        
        const primaryBoxes = allBoxes.filter(box => {
            const aspectRatio = box.h / box.w;
            return box.area > textDetectionSettings.detectAreaLowerBound &&
                   box.area < textDetectionSettings.detectAreaUpperBound &&
                   aspectRatio < textDetectionSettings.detectAspRatioBound &&
                   (1 / aspectRatio) < textDetectionSettings.detectAspRatioBound;
        });
        console.log(`Text detection: Filtered down to ${primaryBoxes.length} primary boxes.`);

        const finalBoxes: BoundingBox[] = [];
        const processedIndices = new Set<number>();

        for (const primaryBox of primaryBoxes) {
            if (processedIndices.has(primaryBox.id)) continue;

            const upad = textDetectionSettings.overlapUpperTolerance;
            const dpad = textDetectionSettings.overlapLowerTolerance;
            const lpad = textDetectionSettings.overlapLeftTolerance;
            const rpad = textDetectionSettings.overlapRightTolerance;

            let overlappingBoxes: BoundingBox[] = [primaryBox];

            for (const otherBox of allBoxes) {
                if (otherBox.id === primaryBox.id) continue;
                
                const otherAspRatio = otherBox.w / otherBox.h;
                const isDiacritic = otherBox.area > textDetectionSettings.overlapAreaLowerBound &&
                                    otherBox.area < textDetectionSettings.detectAreaLowerBound &&
                                    otherAspRatio < textDetectionSettings.overlapAspRatioBound &&
                                    (1 / otherAspRatio) < textDetectionSettings.overlapAspRatioBound;

                if (isDiacritic && bbox_overlap3(primaryBox, otherBox, lpad, rpad, upad, dpad)) {
                    overlappingBoxes.push(otherBox);
                    processedIndices.add(otherBox.id);
                }
            }
            
            let finalBox: BoundingBox;
            if (overlappingBoxes.length > 1) {
                const xMin = Math.min(...overlappingBoxes.map(b => b.x));
                const yMin = Math.min(...overlappingBoxes.map(b => b.y));
                const xMax = Math.max(...overlappingBoxes.map(b => b.x + b.w));
                const yMax = Math.max(...overlappingBoxes.map(b => b.y + b.h));
                finalBox = { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin, area: 0, id: primaryBox.id };
            } else {
                finalBox = primaryBox;
            }

            const padding = textDetectionSettings.cropPaddingWidth;
            finalBoxes.push({
                ...finalBox,
                x: finalBox.x - padding,
                y: finalBox.y - padding,
                w: finalBox.w + 2 * padding,
                h: finalBox.h + 2 * padding,
                class: 'Man', // Default class
            });
            processedIndices.add(primaryBox.id);
        }

        console.log(`Text detection: Created ${finalBoxes.length} final merged boxes.`);
        // Visualization
        const imageRgb = new cv.Mat();
        cv.cvtColor(gray, imageRgb, cv.COLOR_GRAY2BGR, 0);
        finalBoxes.forEach(box => {
            const point1 = new cv.Point(box.x, box.y);
            const point2 = new cv.Point(box.x + box.w, box.y + box.h);
            const color = new cv.Scalar(0, 0, 255, 255);
            cv.rectangle(imageRgb, point1, point2, color, 2);
        });
        const canvas = document.createElement('canvas');
        cv.imshow(canvas, imageRgb);
        const detectionImage = canvas.toDataURL('image/jpeg');
        console.log("Text detection: Visualization complete.");

        src.delete(); gray.delete(); imgDenoise.delete(); dilateKernel.delete(); imgDilate.delete(); labels.delete(); stats.delete(); centroids.delete(); imageRgb.delete();
        return { detectionImage, boxes: finalBoxes };
    } catch (error) {
        console.error("Error during text detection:", error);
        return { detectionImage: null, boxes: [] };
    }
  }


  const handleExportCSV = async () => {
    if (!preprocessedImage || finalBoundingBoxes.length === 0) {
      console.warn("Export skipped: required data is missing.");
      alert("Cannot export: Missing preprocessed image or bounding boxes.");
      return;
    }

    console.log("Starting CSV export process...");
    try {
      const imageElement = new Image();
      imageElement.src = preprocessedImage;
      await new Promise((resolve, reject) => {
          imageElement.onload = resolve;
          imageElement.onerror = (err) => {
            console.error("Failed to load preprocessed image for export.", err);
            reject(new Error("Image loading for export failed."));
          }
      });

      const imageWidth = imageElement.naturalWidth;
      const imageHeight = imageElement.naturalHeight;
      
      // Filter out excluded boxes
      const boxesToExport = finalBoundingBoxes.filter(box => !excludedIndices.includes(box.id));
      
      if (boxesToExport.length === 0) {
        alert("No bounding boxes to export.");
        return;
      }

      // Sort boxes: left-to-right by column, then top-to-bottom within each column
      // This matches the original clustering logic
      const sortedBoxes = sortBoxesByColumns(boxesToExport);

      // Generate CSV content in YOLO format
      // Format: filename, x_center, y_center, width, height (all normalized 0-1)
      const csvLines: string[] = [];
      
      // Use the original filename
      const filename = originalFileName || 'image.jpg';
      
      sortedBoxes.forEach(box => {
        // Calculate YOLO format coordinates (normalized 0-1)
        const x_center = (box.x + box.w / 2) / imageWidth;
        const y_center = (box.y + box.h / 2) / imageHeight;
        const width = box.w / imageWidth;
        const height = box.h / imageHeight;
        
        // Ensure values are within [0, 1] range
        const normalized_x_center = Math.max(0, Math.min(1, x_center));
        const normalized_y_center = Math.max(0, Math.min(1, y_center));
        const normalized_width = Math.max(0, Math.min(1, width));
        const normalized_height = Math.max(0, Math.min(1, height));
        
        // Get class, default to empty string if not set
        const boxClass = box.class || '';
        
        csvLines.push(`${filename},${boxClass},${normalized_x_center.toFixed(6)},${normalized_y_center.toFixed(6)},${normalized_width.toFixed(6)},${normalized_height.toFixed(6)}`);
      });
      
      // Create CSV content with header
      const csvContent = ['filename,class,x_center,y_center,width,height', ...csvLines].join('\n');
      
      // Create download link
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      const nameWithoutExtension = originalFileName.split('.').slice(0, -1).join('.') || 'yolo_coordinates';
      link.download = `${nameWithoutExtension}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
      
      console.log(`Exported ${boxesToExport.length} bounding boxes to CSV.`);
    } catch (error) {
        console.error("Failed to export CSV file:", error);
        alert("An error occurred while exporting the CSV file. Check the console for details.");
    }
  };

  if (!cvReady) {
    return <div className="loading-screen">Loading OpenCV.js...</div>;
  }

  return (
    <div className="container">
      {!cvReady ? (
        <div className="loading-screen">Loading OpenCV...</div>
      ) : (
        <>
          <header className="header">
            <div className="header-left">
              <span onClick={() => window.location.reload()} style={{ cursor: 'pointer' }}>LRL Text-Matching</span>
            </div>
            <div className="header-right">
              <a href="#/about" target="_blank" rel="noopener noreferrer">About Us</a>
              <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} className="theme-toggle">
                {theme === 'dark' ? '☀️' : '🌙'}
              </button>
            </div>
          </header>
          <div className="main-content-wrapper">
            <AppStepper currentStep={currentStep} maxCompletedStep={maxCompletedStep} onStepClick={handleStepClick} />
            <div className={`content-area ${currentStep > 0 ? 'sticky-layout' : ''}`} ref={contentAreaRef}>
              <div className="left-panel" ref={leftPanelRef}>
                {currentStep === 0 && (
                  <SettingsPanel 
                    preprocessSettings={preprocessSettings} 
                    onPreprocessSettingsChange={setPreprocessSettings} 
                    textDetectionSettings={textDetectionSettings}
                    onTextDetectionSettingsChange={setTextDetectionSettings}
                    isExpanded={isSettingsExpanded}
                    onToggle={() => setIsSettingsExpanded(!isSettingsExpanded)}
                    onReset={handleResetSettings}
                  />
                )}
                {currentStep === 1 && <div className="panel-container"><h3>Fine-Tune Detections</h3><p>Click and drag on empty space to draw a new box.<br/>Click a box to select it for moving or resizing.<br/>Hold Shift and click to select multiple boxes.<br/>Press 'Delete' or 'Backspace' to remove selected box(es).</p></div>}
                {currentStep === 2 && (
                  <TagClassesPanel 
                    boxes={finalBoundingBoxes.filter(box => !excludedIndices.includes(box.id))} 
                    onBoxClassChange={handleBoxClassChange}
                    selectedBoxIds={selectedBoxIdsForTagging}
                    onSelectedBoxIdsChange={setSelectedBoxIdsForTagging}
                  />
                )}
                {currentStep === 3 && <ExportCoordinatesPanel onExport={handleExportCSV} boxCount={finalBoundingBoxes.filter(box => !excludedIndices.includes(box.id)).length} />}
              </div>
              <div className="right-panel" ref={fineTunePanelRef}>
                {currentStep === 0 && (
                  sourceImage ? (
                    image ? (
                      <ReactCrop crop={crop} onChange={c => setCrop(c)}>
                        <img ref={imgRef} src={image} alt="for cropping" />
                      </ReactCrop>
                    ) : (
                      <div className="image-placeholder">Preprocessing...</div>
                    )
                  ) : (
                    <UploadPanel onFileSelect={handleFileSelect} />
                  )
                )}
                {currentStep === 1 && (preprocessedImage ? <FineTuneCanvas image={preprocessedImage} boxes={finalBoundingBoxes} setBoxes={setFinalBoundingBoxes} stageSize={stageSize} /> : <div className="image-placeholder">No image to fine-tune</div>)}
                {currentStep === 2 && (preprocessedImage ? <TagClassesCanvas image={preprocessedImage} boxes={finalBoundingBoxes.filter(box => !excludedIndices.includes(box.id))} selectedBoxIds={selectedBoxIdsForTagging} onSelectedBoxIdsChange={setSelectedBoxIdsForTagging} /> : <div className="image-placeholder">No image for tagging</div>)}
                {currentStep === 3 && (preprocessedImage ? <ExportCoordinatesCanvas image={preprocessedImage} boxes={finalBoundingBoxes.filter(box => !excludedIndices.includes(box.id))} /> : <div className="image-placeholder">No image for export</div>)}
              </div>
            </div>
          </div>
          <AppControls currentStep={currentStep} onBack={handleBack} onNext={handleNext} />
        </>
      )}
    </div>
  );
};

function bbox_overlap3(box1: BoundingBox, box2: BoundingBox, lpad: number, rpad: number, upad: number, dpad: number): boolean {
    const x1 = box1.x, y1 = box1.y, w1 = box1.w, h1 = box1.h;
    const x2 = box2.x, y2 = box2.y, w2 = box2.w, h2 = box2.h;
    return (x1 - lpad < x2 + w2 && 
            x2 < x1 + w1 + rpad && 
            y1 - upad < y2 + h2 && 
            y2 < y1 + h1 + dpad);
}

/**
 * Sort bounding boxes by columns (left-to-right) and then by rows (top-to-bottom) within each column.
 * This matches the original clustering logic for reading order.
 */
function sortBoxesByColumns(boxes: BoundingBox[]): BoundingBox[] {
    if (boxes.length === 0) return [];
    
    // Calculate center X for each box
    const boxesWithCenters = boxes.map(box => ({
        box,
        centerX: box.x + box.w / 2,
        centerY: box.y + box.h / 2,
    }));
    
    // Estimate column width - use average box width as a threshold
    const avgBoxWidth = boxes.reduce((sum, box) => sum + box.w, 0) / boxes.length;
    const columnThreshold = avgBoxWidth * 0.5; // Boxes within 50% of average width are in same column
    
    // Group boxes into columns based on X position
    const columns: BoundingBox[][] = [];
    const sortedByX = [...boxesWithCenters].sort((a, b) => a.centerX - b.centerX);
    
    sortedByX.forEach(({ box, centerX }) => {
        // Find existing column that this box belongs to
        let foundColumn = false;
        for (const column of columns) {
            // Check if box's X center is close to the column's average X
            const columnAvgX = column.reduce((sum, b) => sum + (b.x + b.w / 2), 0) / column.length;
            if (Math.abs(centerX - columnAvgX) < columnThreshold) {
                column.push(box);
                foundColumn = true;
                break;
            }
        }
        
        // If no matching column found, create a new one
        if (!foundColumn) {
            columns.push([box]);
        }
    });
    
    // Sort columns by their average X position (left to right)
    columns.sort((col1, col2) => {
        const avgX1 = col1.reduce((sum, box) => sum + (box.x + box.w / 2), 0) / col1.length;
        const avgX2 = col2.reduce((sum, box) => sum + (box.x + box.w / 2), 0) / col2.length;
        return avgX1 - avgX2;
    });
    
    // Sort boxes within each column by Y position (top to bottom)
    columns.forEach(column => {
        column.sort((a, b) => a.y - b.y);
    });
    
    // Flatten columns into a single array
    return columns.flat();
}

const UploadPanel: FC<UploadPanelProps> = ({ onFileSelect }) => {
  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      onFileSelect(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onFileSelect(e.target.files[0]);
    }
  };

  return (
    <div 
      className="dropzone"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onClick={() => document.getElementById('file-input')?.click()}
    >
      Drag and drop an image here, or click to select a file
      <input 
        type="file" 
        id="file-input" 
        style={{ display: 'none' }}
        onChange={handleChange}
        accept="image/*"
      />
    </div>
  );
};

const SettingsPanel: FC<SettingsPanelProps> = ({
  preprocessSettings,
  onPreprocessSettingsChange,
  textDetectionSettings,
  onTextDetectionSettingsChange,
  isExpanded,
  onToggle,
  onReset,
}) => {
  const handlePreprocessSettingChange = (key: keyof PreprocessSettings, value: string) => {
    onPreprocessSettingsChange({ ...preprocessSettings, [key]: Number(value) });
  };

  const handleTextDetectionSettingChange = (key: keyof TextDetectionSettings, value: string) => {
    onTextDetectionSettingsChange({ ...textDetectionSettings, [key]: Number(value) });
  };

  const textDetectionSettingInputs: { key: keyof TextDetectionSettings; label: string; description: string; min: number; max: number; }[] = [
      { key: 'detectDilateKernelWidth', label: 'DETECT_DILATE_KERNEL_WIDTH', description: 'Dilation kernel width for text detection', min: 1, max: 21 },
      { key: 'detectAreaLowerBound', label: 'DETECT_AREA_LOWER_BOUND', description: 'Minimum area threshold for text regions', min: 10, max: 1000 },
      { key: 'detectAreaUpperBound', label: 'DETECT_AREA_UPPER_BOUND', description: 'Maximum area threshold for text regions', min: 1000, max: 30000 },
      { key: 'detectAspRatioBound', label: 'DETECT_ASP_RATIO_BOUND', description: 'Aspect ratio bound for text detection', min: 1, max: 20 },
      { key: 'overlapAreaLowerBound', label: 'OVERLAP_AREA_LOWER_BOUND', description: 'Minimum area for overlapping regions', min: 1, max: 200 },
      { key: 'overlapAspRatioBound', label: 'OVERLAP_ASP_RATIO_BOUND', description: 'Aspect ratio bound for overlapping regions', min: 1, max: 20 },
      { key: 'overlapUpperTolerance', label: 'OVERLAP_UPPER_TOLORANCE', description: 'Upper tolerance for overlap detection', min: 0, max: 20 },
      { key: 'overlapLowerTolerance', label: 'OVERLAP_LOWER_TOLORANCE', description: 'Lower tolerance for overlap detection', min: 0, max: 20 },
      { key: 'overlapLeftTolerance', label: 'OVERLAP_LEFT_TOLORANCE', description: 'Left tolerance for overlap detection', min: 0, max: 20 },
      { key: 'overlapRightTolerance', label: 'OVERLAP_RIGHT_TOLORANCE', description: 'Right tolerance for overlap detection', min: 0, max: 20 },
      { key: 'cropPaddingWidth', label: 'CROP_PADDING_WIDTH', description: 'Padding width for cropped regions', min: 0, max: 20 },
  ];

  return (
    <div className={`settings-panel ${isExpanded ? '' : 'collapsed'}`}>
      <div className="settings-panel-header" onClick={onToggle}>
        <h3>Settings</h3>
        <button className="collapse-button">{isExpanded ? '▲' : '▼'}</button>
      </div>
      {isExpanded && (
        <div className="settings-panel-content">
          <h3>Preprocessing Settings</h3>
          <div className="slider-group">
            <label>ADAPTIVE_BLOCK_SIZE</label>
            <span>Adaptive threshold block size</span>
            <input 
              type="range" 
              min="3" 
              max="255" 
              step="2"
              value={preprocessSettings.adaptiveBlockSize} 
              onChange={(e) => handlePreprocessSettingChange('adaptiveBlockSize', e.target.value)} 
            />
            <span>{preprocessSettings.adaptiveBlockSize}</span>
          </div>
          <div className="slider-group">
            <label>ADAPTIVE_C</label>
            <span>Adaptive threshold constant</span>
            <input 
              type="range" 
              min="0" 
              max="50" 
              value={preprocessSettings.adaptiveC} 
              onChange={(e) => handlePreprocessSettingChange('adaptiveC', e.target.value)} 
            />
            <span>{preprocessSettings.adaptiveC}</span>
          </div>
          <div className="slider-group">
            <label>DENOISE_CLOSE_KERNEL_WIDTH</label>
            <span>Closing kernel width for denoising</span>
            <input 
              type="range" 
              min="1" 
              max="21" 
              value={preprocessSettings.denoiseCloseKernelWidth} 
              onChange={(e) => handlePreprocessSettingChange('denoiseCloseKernelWidth', e.target.value)} 
            />
            <span>{preprocessSettings.denoiseCloseKernelWidth}</span>
          </div>
          <div className="slider-group">
            <label>DENOISE_OPEN_KERNEL_WIDTH</label>
            <span>Opening kernel width for denoising</span>
            <input 
              type="range" 
              min="1" 
              max="21" 
              value={preprocessSettings.denoiseOpenKernelWidth} 
              onChange={(e) => handlePreprocessSettingChange('denoiseOpenKernelWidth', e.target.value)} 
            />
            <span>{preprocessSettings.denoiseOpenKernelWidth}</span>
          </div>
          <h3>Text Detection Settings</h3>
          {textDetectionSettingInputs.map(({ key, label, description, min, max }) => (
              <div className="slider-group" key={key}>
                  <label>{label}</label>
                  <span>{description}</span>
                  <input
                      type="range"
                      min={min}
                      max={max}
                      value={textDetectionSettings[key]}
                      onChange={(e) => handleTextDetectionSettingChange(key, e.target.value)}
                  />
                  <span>{textDetectionSettings[key]}</span>
              </div>
          ))}
          <button onClick={onReset} className="button-style" style={{marginTop: '1rem'}}>
            Reset to Defaults
          </button>
        </div>
      )}
    </div>
  );
};

interface FineTuneCanvasProps {
  image: string | null;
  boxes: BoundingBox[];
  setBoxes: (boxes: BoundingBox[]) => void;
  stageSize: { width: number; height: number };
}

const FineTuneCanvas: FC<FineTuneCanvasProps> = ({ image, boxes, setBoxes, stageSize }) => {
    const [konvaImage, setKonvaImage] = useState<HTMLImageElement | null>(null);
    const [selectedBoxIds, setSelectedBoxIds] = useState<number[]>([]);
    const [hoveredBoxId, setHoveredBoxId] = useState<number | null>(null);
    
    const stageRef = useRef<any>(null);
    const transformerRef = useRef<any>(null);
    const drawingRectRef = useRef<{ x: number, y: number, w: number, h: number } | null>(null);
    const layerRef = useRef<any>(null);

    useEffect(() => {
        if (image) {
            const img = new window.Image();
            img.src = image;
            img.onload = () => setKonvaImage(img);
        }
    }, [image]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && selectedBoxIds.length > 0) {
                setBoxes(boxes.filter(box => !selectedBoxIds.includes(box.id)));
                setSelectedBoxIds([]);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selectedBoxIds, boxes, setBoxes]);

    useEffect(() => {
        const transformer = transformerRef.current;
        if (!transformer) return;

        // Only show transformer for single selection (multi-selection disables transformation)
        if (selectedBoxIds.length === 1) {
            const stage = stageRef.current;
            const targetNode = stage.findOne('#' + selectedBoxIds[0]);
            if (targetNode) {
                transformer.nodes([targetNode]);
            } else {
                transformer.nodes([]);
            }
        } else if (selectedBoxIds.length === 0 && hoveredBoxId) {
            // Show transformer on hover when nothing is selected
            const stage = stageRef.current;
            const targetNode = stage.findOne('#' + hoveredBoxId);
            if (targetNode) {
                transformer.nodes([targetNode]);
            } else {
                transformer.nodes([]);
            }
        } else {
            transformer.nodes([]);
        }
    }, [selectedBoxIds, hoveredBoxId]);
    
    const getScale = () => {
        if (!konvaImage || !stageSize.width || !stageSize.height) {
            return { scale: 1, offsetX: 0, offsetY: 0 };
        }
        const scaleX = stageSize.width / konvaImage.width;
        const scaleY = stageSize.height / konvaImage.height;
        const scale = Math.min(scaleX, scaleY);
        const offsetX = (stageSize.width - konvaImage.width * scale) / 2;
        const offsetY = (stageSize.height - konvaImage.height * scale) / 2;
        return { scale, offsetX, offsetY };
    };
    
    const { scale, offsetX, offsetY } = getScale();

    const toOriginalCoords = (pos: {x: number, y: number}) => {
        return {
            x: (pos.x - offsetX) / scale,
            y: (pos.y - offsetY) / scale,
        };
    };
    
    const handleStageMouseDown = (e: KonvaEventObject<MouseEvent>) => {
        if (e.target === e.target.getStage() || e.target.hasName('background-image')) {
            const pos = e.target.getStage()!.getPointerPosition()!;
            const originalPos = toOriginalCoords(pos);
            drawingRectRef.current = { x: originalPos.x, y: originalPos.y, w: 0, h: 0 };
            // Clear selection if not holding Shift
            if (!e.evt.shiftKey) {
                setSelectedBoxIds([]);
            }
        }
    };
    
    const handleStageMouseMove = (e: KonvaEventObject<MouseEvent>) => {
        if (drawingRectRef.current) {
            const pos = e.target.getStage()!.getPointerPosition()!;
            const originalPos = toOriginalCoords(pos);
            const { x, y } = drawingRectRef.current;
            drawingRectRef.current = { x, y, w: originalPos.x - x, h: originalPos.y - y };
            layerRef.current.batchDraw();
        }
    };
    
    const handleStageMouseUp = () => {
        if (drawingRectRef.current) {
            const { x, y, w, h } = drawingRectRef.current;
            if (Math.abs(w) > 5 && Math.abs(h) > 5) { // Threshold to prevent tiny boxes on click
                const newBox: BoundingBox = {
                    x: w > 0 ? x : x + w,
                    y: h > 0 ? y : y + h,
                    w: Math.abs(w),
                    h: Math.abs(h),
                    area: Math.abs(w * h),
                    id: Date.now(),
                    class: 'Man', // Default class
                };
                setBoxes([...boxes, newBox]);
            }
            drawingRectRef.current = null;
        }
    };

    return (
        <Stage
            ref={stageRef}
            width={stageSize.width}
            height={stageSize.height}
            onMouseDown={handleStageMouseDown}
            onMouseMove={handleStageMouseMove}
            onMouseUp={handleStageMouseUp}
        >
            <Layer ref={layerRef} scaleX={scale} scaleY={scale} x={offsetX} y={offsetY}>
                {konvaImage && <KonvaImage image={konvaImage} name="background-image"/>}
                {boxes.map((box) => (
                    <KonvaRect
                        key={box.id}
                        id={String(box.id)}
                        x={box.x}
                        y={box.y}
                        width={box.w}
                        height={box.h}
                        stroke={selectedBoxIds.includes(box.id) ? 'cyan' : hoveredBoxId === box.id ? 'yellow' : 'red'}
                        strokeWidth={selectedBoxIds.includes(box.id) ? 3 / scale : 2 / scale} // Thicker stroke for selected
                        hitStrokeWidth={20 / scale} // Increase hit area for easier interaction
                        draggable={selectedBoxIds.length <= 1} // Only allow dragging single selection
                        onClick={(e) => {
                            const isSelected = selectedBoxIds.includes(box.id);
                            if (e.evt.shiftKey) {
                                // Multi-select mode: toggle the clicked box
                                if (isSelected) {
                                    setSelectedBoxIds(selectedBoxIds.filter(id => id !== box.id));
                                } else {
                                    setSelectedBoxIds([...selectedBoxIds, box.id]);
                                }
                            } else {
                                // Single click: replace selection with just this box
                                if (isSelected && selectedBoxIds.length === 1) {
                                    // If it's the only selected box, deselect it
                                    setSelectedBoxIds([]);
                                } else {
                                    // Otherwise, select only this box
                                    setSelectedBoxIds([box.id]);
                                }
                            }
                            setHoveredBoxId(null);
                        }}
                        onTap={(e) => {
                            const isSelected = selectedBoxIds.includes(box.id);
                            const evt = e.evt as MouseEvent;
                            if (evt.shiftKey) {
                                // Multi-select mode: toggle the clicked box
                                if (isSelected) {
                                    setSelectedBoxIds(selectedBoxIds.filter(id => id !== box.id));
                                } else {
                                    setSelectedBoxIds([...selectedBoxIds, box.id]);
                                }
                            } else {
                                // Single tap: replace selection with just this box
                                if (isSelected && selectedBoxIds.length === 1) {
                                    setSelectedBoxIds([]);
                                } else {
                                    setSelectedBoxIds([box.id]);
                                }
                            }
                            setHoveredBoxId(null);
                        }}
                        onMouseEnter={() => setHoveredBoxId(box.id)}
                        onMouseLeave={() => setHoveredBoxId(null)}
                        onTransformEnd={(e) => {
                            // Only allow transform for single selection
                            if (selectedBoxIds.length !== 1 || !selectedBoxIds.includes(box.id)) return;
                            
                            const node = e.target;
                            const newScaleX = node.scaleX();
                            const newScaleY = node.scaleY();
                            node.scaleX(1);
                            node.scaleY(1);
                            const newBoxes = boxes.map(b => 
                                b.id === box.id ? {
                                    ...b,
                                    x: node.x(),
                                    y: node.y(),
                                    w: Math.max(5, b.w * newScaleX),
                                    h: Math.max(5, b.h * newScaleY),
                                } : b
                            );
                            setBoxes(newBoxes);
                        }}
                        onDragEnd={(e) => {
                            // Only allow drag for single selection
                            if (selectedBoxIds.length !== 1 || !selectedBoxIds.includes(box.id)) return;
                            
                            const newBoxes = boxes.map(b => 
                                b.id === box.id ? { ...b, x: e.target.x(), y: e.target.y() } : b
                            );
                            setBoxes(newBoxes);
                        }}
                    />
                ))}
                {drawingRectRef.current && (
                    <KonvaRect
                        x={drawingRectRef.current.x}
                        y={drawingRectRef.current.y}
                        width={drawingRectRef.current.w}
                        height={drawingRectRef.current.h}
                        fill="rgba(0,0,255,0.2)"
                        stroke="blue"
                        strokeWidth={1 / scale}
                    />
                )}
                <Transformer
                    ref={transformerRef}
                    boundBoxFunc={(oldBox, newBox) => {
                        // limit resize
                        if (newBox.width < 5 || newBox.height < 5) {
                            return oldBox;
                        }
                        return newBox;
                    }}
                />
            </Layer>
        </Stage>
    );
};

interface TagClassesPanelProps {
    boxes: BoundingBox[];
    onBoxClassChange: (boxIds: number[], boxClass: BoxClass | undefined) => void;
    selectedBoxIds: number[];
}

const TagClassesPanel: FC<TagClassesPanelProps> = ({ boxes, onBoxClassChange, selectedBoxIds }) => {
    const selectedBoxes = boxes.filter(box => selectedBoxIds.includes(box.id));
    const classOptions: BoxClass[] = ['Man', 'Chi', 'Frame'];
    
    // Check if all selected boxes have the same class
    const getCommonClass = (): BoxClass | undefined => {
        if (selectedBoxes.length === 0) return undefined;
        const firstClass = selectedBoxes[0].class;
        if (selectedBoxes.every(box => box.class === firstClass)) {
            return firstClass;
        }
        return undefined;
    };
    
    const commonClass = getCommonClass();
    
    return (
        <div className="panel-container">
            <h3>Tag Classes</h3>
            <p>Click on bounding boxes in the image to select them (you can select multiple), then choose a class to tag all selected boxes at once.</p>
            {selectedBoxIds.length > 0 ? (
                <div style={{ marginTop: '1rem' }}>
                    <p style={{ fontSize: '0.75rem', color: '#8b949e', marginBottom: '0.5rem' }}>
                        Selected: <strong>{selectedBoxIds.length}</strong> box{selectedBoxIds.length > 1 ? 'es' : ''}
                    </p>
                    {commonClass && (
                        <p style={{ fontSize: '0.625rem', color: '#8b949e', marginBottom: '0.5rem' }}>
                            All selected boxes are tagged as: <strong>{commonClass}</strong>
                        </p>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        {classOptions.map((boxClass) => (
                            <button
                                key={boxClass}
                                onClick={() => {
                                    onBoxClassChange(selectedBoxIds, boxClass);
                                }}
                                className="button-style"
                                style={{
                                    backgroundColor: commonClass === boxClass ? 'var(--primary)' : 'var(--muted)',
                                    fontSize: '0.5rem',
                                }}
                            >
                                Tag as {boxClass} {commonClass === boxClass ? '✓' : ''}
                            </button>
                        ))}
                        <button
                            onClick={() => {
                                onBoxClassChange(selectedBoxIds, undefined);
                            }}
                            className="button-style"
                            style={{
                                backgroundColor: !commonClass ? 'var(--primary)' : 'var(--muted)',
                                fontSize: '0.5rem',
                            }}
                        >
                            Clear Tags {!commonClass ? '✓' : ''}
                        </button>
                    </div>
                </div>
            ) : (
                <p style={{ fontSize: '0.625rem', color: '#8b949e', marginTop: '0.5rem' }}>
                    No boxes selected. Click on boxes in the image to select them (hold Shift to select multiple).
                </p>
            )}
            <div style={{ marginTop: '1rem', fontSize: '0.625rem', color: '#8b949e' }}>
                <p>Tagged: {boxes.filter(box => box.class).length} / {boxes.length}</p>
            </div>
        </div>
    );
};

interface TagClassesCanvasProps {
    image: string | null;
    boxes: BoundingBox[];
    selectedBoxIds: number[];
    onSelectedBoxIdsChange: (boxIds: number[]) => void;
}

const TagClassesCanvas: FC<TagClassesCanvasProps> = ({ image, boxes, selectedBoxIds, onSelectedBoxIdsChange }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (image && canvasRef.current) {
            const canvas = canvasRef.current;
            const context = canvas.getContext('2d');
            if (!context) return;

            const img = new Image();
            img.src = image;
            img.onload = () => {
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                context.drawImage(img, 0, 0);

                if (boxes.length > 0) {
                    boxes.forEach(box => {
                        // Color based on class
                        let strokeColor = 'red';
                        if (box.class === 'Man') strokeColor = 'blue';
                        else if (box.class === 'Chi') strokeColor = 'green';
                        else if (box.class === 'Frame') strokeColor = 'orange';
                        
                        // Highlight selected boxes
                        if (selectedBoxIds.includes(box.id)) {
                            context.strokeStyle = 'cyan';
                            context.lineWidth = 5;
                        } else {
                            context.strokeStyle = strokeColor;
                            context.lineWidth = 3;
                        }
                        context.strokeRect(box.x, box.y, box.w, box.h);
                        
                        // Draw class label if tagged
                        if (box.class) {
                            context.fillStyle = strokeColor;
                            context.font = 'bold 20px Arial';
                            context.fillText(box.class, box.x, box.y - 5);
                        }
                    });
                }
            };
        }
    }, [image, boxes, selectedBoxIds]);

    const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
        if (!canvasRef.current) return;
        
        const canvas = canvasRef.current;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        
        // Find clicked box
        const clickedBox = boxes.find(box => 
            x >= box.x && x <= box.x + box.w &&
            y >= box.y && y <= box.y + box.h
        );
        
        if (clickedBox) {
            const isSelected = selectedBoxIds.includes(clickedBox.id);
            if (e.shiftKey) {
                // Multi-select mode: toggle the clicked box
                if (isSelected) {
                    onSelectedBoxIdsChange(selectedBoxIds.filter(id => id !== clickedBox.id));
                } else {
                    onSelectedBoxIdsChange([...selectedBoxIds, clickedBox.id]);
                }
            } else {
                // Single click: replace selection with just this box
                if (isSelected && selectedBoxIds.length === 1) {
                    // If it's the only selected box, deselect it
                    onSelectedBoxIdsChange([]);
                } else {
                    // Otherwise, select only this box
                    onSelectedBoxIdsChange([clickedBox.id]);
                }
            }
        } else {
            // Clicked outside any box - clear selection if not holding Shift
            if (!e.shiftKey) {
                onSelectedBoxIdsChange([]);
            }
        }
    };

    return (
        <canvas 
            ref={canvasRef} 
            style={{ maxWidth: '100%', maxHeight: '100%', cursor: 'pointer' }}
            onClick={handleCanvasClick}
        />
    );
};

interface ExportCoordinatesPanelProps {
    onExport: () => void;
    boxCount: number;
}

const ExportCoordinatesPanel: FC<ExportCoordinatesPanelProps> = ({ onExport, boxCount }) => {
    return (
        <div className="panel-container">
            <h3>Export Coordinates</h3>
            <p>Export bounding box coordinates in YOLO format for training your word detection model.</p>
            <p style={{ fontSize: '0.75rem', color: '#8b949e', marginTop: '0.5rem' }}>
                Detected boxes: <strong>{boxCount}</strong>
            </p>
            <p style={{ fontSize: '0.625rem', color: '#8b949e', marginTop: '0.5rem' }}>
                Format: filename, class, x_center, y_center, width, height<br/>
                (All coordinates are normalized between 0 and 1)
            </p>
            <button onClick={onExport} className="button-style" disabled={boxCount === 0}>
                Export CSV
            </button>
        </div>
    );
};

interface ExportCoordinatesCanvasProps {
    image: string | null;
    boxes: BoundingBox[];
}

const ExportCoordinatesCanvas: FC<ExportCoordinatesCanvasProps> = ({ image, boxes }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (image && canvasRef.current) {
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');
        if (!context) return;

        const img = new Image();
        img.src = image;
        img.onload = () => {
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            context.drawImage(img, 0, 0);

            if (boxes.length > 0) {
              // Draw boxes with colors based on class
              boxes.forEach(box => {
                  let strokeColor = 'red'; // Default for untagged
                  if (box.class === 'Man') strokeColor = 'blue';
                  else if (box.class === 'Chi') strokeColor = 'green';
                  else if (box.class === 'Frame') strokeColor = 'orange';
                  
                  context.strokeStyle = strokeColor;
                  context.lineWidth = 3;
                  context.strokeRect(box.x, box.y, box.w, box.h);
                  
                  // Draw class label if tagged
                  if (box.class) {
                      context.fillStyle = strokeColor;
                      context.font = 'bold 20px Arial';
                      context.fillText(box.class, box.x, box.y - 5);
                  }
              });
            }
        };
    }
  }, [image, boxes]);

    return <canvas ref={canvasRef} style={{ maxWidth: '100%', maxHeight: '100%' }} />;
};


export default App;
