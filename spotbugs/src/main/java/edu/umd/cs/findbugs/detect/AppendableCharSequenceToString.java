/*
 * FindBugs - Find bugs in Java programs
 * Copyright (C) 2026 SpotBugs Project Contributors
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
 */

package edu.umd.cs.findbugs.detect;

import org.apache.bcel.Const;

import edu.umd.cs.findbugs.BugInstance;
import edu.umd.cs.findbugs.BugReporter;
import edu.umd.cs.findbugs.OpcodeStack.Item;
import edu.umd.cs.findbugs.StatelessDetector;
import edu.umd.cs.findbugs.bcel.OpcodeStackDetector;

/**
 * Find occurrences of calling toString() on CharSequence objects when appending
 * to Appendable objects. This is inefficient because Appendable.append() can
 * directly accept CharSequence without the need to convert to String.
 * 
 * Detects patterns like:
 * - appendable.append(charSequence.toString())
 * 
 * And suggests using:
 * - appendable.append(charSequence)
 *
 * @author SpotBugs Project Contributors
 */
public class AppendableCharSequenceToString extends OpcodeStackDetector implements StatelessDetector {

    private static final int SEEN_NOTHING = 0;
    private static final int SEEN_CHARSEQUENCE_TOSTRING = 1;
    
    private final BugReporter bugReporter;
    private int state = SEEN_NOTHING;

    public AppendableCharSequenceToString(BugReporter bugReporter) {
        this.bugReporter = bugReporter;
    }

    @Override
    public void sawOpcode(int seen) {
        switch (state) {
            case SEEN_NOTHING:
                if (seen == Const.INVOKEVIRTUAL && "toString".equals(getNameConstantOperand()) 
                        && "()Ljava/lang/String;".equals(getSigConstantOperand())) {
                    
                    // Check if the receiver is a CharSequence implementation
                    String className = getClassConstantOperand();
                    if (isCharSequenceImplementation(className)) {
                        state = SEEN_CHARSEQUENCE_TOSTRING;
                    }
                }
                break;
                
            case SEEN_CHARSEQUENCE_TOSTRING:
                if (seen == Const.INVOKEVIRTUAL && "append".equals(getNameConstantOperand())
                        && isAppendableClass(getClassConstantOperand())) {
                    
                    // Check if the signature indicates we're appending a String
                    String signature = getSigConstantOperand();
                    if (signature.startsWith("(Ljava/lang/String;)") || 
                        signature.startsWith("(Ljava/lang/CharSequence;)")) {
                        
                        // Found the inefficient pattern!
                        bugReporter.reportBug(new BugInstance(this, "ACSTS_APPENDABLE_CHARSEQUENCE_TOSTRING", NORMAL_PRIORITY)
                                .addClassAndMethod(this)
                                .addSourceLine(this));
                    }
                }
                // Reset state after any opcode in this state
                state = SEEN_NOTHING;
                break;
                
            default:
                state = SEEN_NOTHING;
                break;
        }
    }

    /**
     * Check if the class is an Appendable implementation
     */
    private boolean isAppendableClass(String className) {
        if (className == null) {
            return false;
        }
        return className.equals("java/lang/StringBuilder") ||
               className.equals("java/lang/StringBuffer") ||
               className.equals("java/io/StringWriter") ||
               className.equals("java/io/PrintWriter") ||
               className.equals("java/io/BufferedWriter") ||
               className.equals("java/io/CharArrayWriter") ||
               className.equals("java/io/FileWriter") ||
               className.equals("java/io/OutputStreamWriter") ||
               className.equals("java/io/PipedWriter") ||
               className.equals("java/io/Writer");
    }

    /**
     * Check if the class is a CharSequence implementation
     */
    private boolean isCharSequenceImplementation(String className) {
        if (className == null) {
            return false;
        }
        return className.equals("java/lang/CharSequence") ||
               className.equals("java/lang/String") ||
               className.equals("java/lang/StringBuilder") ||
               className.equals("java/lang/StringBuffer") ||
               className.startsWith("java/nio/CharBuffer");
    }
}