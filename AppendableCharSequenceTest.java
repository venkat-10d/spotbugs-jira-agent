import java.io.StringWriter;

/**
 * Test class for the AppendableCharSequenceToString detector.
 * This class contains both inefficient patterns (that should be detected)
 * and efficient patterns (that should not be detected).
 */
public class AppendableCharSequenceTest {
    
    /**
     * BAD: This should be detected - calling toString() on CharSequence when appending
     */
    public void badPatternStringBuilder() {
        StringBuilder sb = new StringBuilder();
        CharSequence cs = "Hello World";
        sb.append(cs.toString());  // SHOULD BE DETECTED: inefficient toString() call
    }
    
    /**
     * BAD: This should be detected - calling toString() on String when appending to StringBuffer
     */
    public void badPatternStringBuffer() {
        StringBuffer sb = new StringBuffer();
        String str = "Hello World";
        sb.append(str.toString());  // SHOULD BE DETECTED: inefficient toString() call on String
    }
    
    /**
     * BAD: This should be detected - calling toString() on StringBuilder when appending to Writer
     */
    public void badPatternWriter() {
        try {
            StringWriter writer = new StringWriter();
            StringBuilder sb = new StringBuilder("Hello");
            writer.append(sb.toString());  // SHOULD BE DETECTED: inefficient toString() call
        } catch (Exception e) {
            // ignore
        }
    }
    
    /**
     * GOOD: This should NOT be detected - direct append of CharSequence
     */
    public void goodPatternDirectAppend() {
        StringBuilder sb = new StringBuilder();
        CharSequence cs = "Hello World";
        sb.append(cs);  // GOOD: no toString() call
    }
    
    /**
     * GOOD: This should NOT be detected - append of String literal
     */
    public void goodPatternStringLiteral() {
        StringBuilder sb = new StringBuilder();
        sb.append("Hello World");  // GOOD: direct string literal
    }
    
    /**
     * GOOD: This should NOT be detected - toString() not used in append context
     */
    public void goodPatternToStringNotInAppend() {
        StringBuilder sb = new StringBuilder("Hello");
        CharSequence cs = "World";
        String result = cs.toString();  // GOOD: toString() not used in append
        sb.append(" ").append(result);
    }
    
    /**
     * GOOD: This should NOT be detected - toString() on non-CharSequence object
     */
    public void goodPatternToStringOnInteger() {
        StringBuilder sb = new StringBuilder();
        Integer num = 42;
        sb.append(num.toString());  // GOOD: toString() on non-CharSequence object
    }
    
    /**
     * BAD: More complex case - should be detected
     */
    public void badPatternChainedCalls() {
        StringBuilder sb = new StringBuilder();
        CharSequence cs = getCharSequence();
        sb.append("Prefix: ").append(cs.toString()).append(" Suffix");  // SHOULD BE DETECTED
    }
    
    private CharSequence getCharSequence() {
        return "Some text";
    }
}