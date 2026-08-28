import java.util.List;

public class Sample {
    private int count;

    public int getCount() {
        return count;
    }

    public void run(List<String> items) {
        for (String s : items) {
            System.out.println(s);
        }
    }
}
