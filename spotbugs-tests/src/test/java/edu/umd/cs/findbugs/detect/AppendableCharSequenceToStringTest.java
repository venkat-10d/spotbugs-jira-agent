package edu.umd.cs.findbugs.detect;

import org.junit.jupiter.api.Test;

import edu.umd.cs.findbugs.AbstractIntegrationTest;
import edu.umd.cs.findbugs.test.matcher.BugInstanceMatcher;
import edu.umd.cs.findbugs.test.matcher.BugInstanceMatcherBuilder;

/**
 * Test for AppendableCharSequenceToString detector.
 * Tests detection of inefficient toString() calls on CharSequence objects 
 * when appending to Appendable objects.
 */
class AppendableCharSequenceToStringTest extends AbstractIntegrationTest {

    @Test
    void testDetectsInefficientPatterns() {
        performAnalysis("AppendableCharSequenceTestCase.class");
        
        BugInstanceMatcher matcher = new BugInstanceMatcherBuilder()
                .bugType("ACSTS_APPENDABLE_CHARSEQUENCE_TOSTRING")
                .build();
        
        // Should detect inefficient patterns
        assertBugInMethod(matcher, "AppendableCharSequenceTestCase", "badPatternStringBuilder");
        assertBugInMethod(matcher, "AppendableCharSequenceTestCase", "badPatternStringBuffer");
        assertBugInMethod(matcher, "AppendableCharSequenceTestCase", "badPatternWriter");
        assertBugInMethod(matcher, "AppendableCharSequenceTestCase", "badPatternChainedCalls");
    }
    
    @Test
    void testDoesNotDetectEfficientPatterns() {
        performAnalysis("AppendableCharSequenceTestCase.class");
        
        BugInstanceMatcher matcher = new BugInstanceMatcherBuilder()
                .bugType("ACSTS_APPENDABLE_CHARSEQUENCE_TOSTRING")
                .build();
        
        // Should NOT detect efficient patterns
        assertNoBugInMethod(matcher, "AppendableCharSequenceTestCase", "goodPatternDirectAppend");
        assertNoBugInMethod(matcher, "AppendableCharSequenceTestCase", "goodPatternStringLiteral");
        assertNoBugInMethod(matcher, "AppendableCharSequenceTestCase", "goodPatternToStringNotInAppend");
        assertNoBugInMethod(matcher, "AppendableCharSequenceTestCase", "goodPatternToStringOnInteger");
    }
}